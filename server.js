const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mqtt = require('mqtt');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Logger = require('./logger');

const app = express();
app.use(express.json());
app.use(cors());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const options = {
  host: 'g1191969.ala.asia-southeast1.emqxsl.com',
  port: 8883,
  protocol: 'mqtts',
  username: 'vehicle_server',
  password: 'StrongPassword@123'
}
const mqttClient = mqtt.connect(options);
// const mqttClient = mqtt.connect(process.env.MQTT_BROKER || 'mqtt://192.168.31.49:1884'); // wifi
// const mqttClient = mqtt.connect(process.env.MQTT_BROKER || 'mqtt://localhost:1883');
// const mqttClient = mqtt.connect(process.env.MQTT_BROKER || 'mqtt://172.20.10.2:1884'); // hotspot
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
const MQTT_TEST_MODE = true;

// Track active timeouts for cleanup
const activeTimeouts = new Map();

// Normalize helper (match your ESP32/STM32 expectations)
const normalizeFeatureId = (name) => name.toLowerCase().replace(/\s+/g, '_');

// ============================================================
// HELPER FUNCTIONS
// ============================================================

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ success: false, message: 'Token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, message: 'Invalid token' });
    req.user = user;
    next();
  });
};

const generateToken = (phone) => jwt.sign({ phone }, JWT_SECRET, { expiresIn: '7d' });
const generateNonce = () => crypto.randomBytes(16).toString('hex');
const signPayload = (featureName) => {
  const hmac = crypto.createHmac('sha256', process.env.OEM_PRIVATE_KEY || 'test-key');
  hmac.update(featureName);
  return hmac.digest('base64');
};

// ============================================================
// IDEMPOTENT ACTIVATION SERVICE
// ============================================================

async function triggerActivation(vin, featureName, vehicleFeaturesId) {
  try {
    console.log('\n==========================================');
    console.log('TRIGGER ACTIVATION SERVICE');
    console.log('==========================================');
    console.log('VIN:', vin);
    console.log('Feature:', featureName);

    // Check if already processing (idempotency)
    const { data: existingJob } = await supabase
      .from('activation_jobs')
      .select('*')
      .eq('vin', vin)
      .eq('feature_name', featureName)
      .in('status', ['created', 'pushed', 'acked'])
      .maybeSingle();

    if (existingJob) {
      console.log('Activation already in progress');
      return existingJob;
    }

    // Generate secure nonce & expiry
    const nonce = generateNonce();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const startTime = Date.now();

    // Create activation job
    const { data: job, error: jobError } = await supabase
      .from('activation_jobs')
      .insert({
        vehicle_features_id: vehicleFeaturesId,
        vin: vin,
        feature_name: featureName,
        nonce: nonce,
        status: 'created',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (jobError) throw jobError;

    console.log('Job created:', job.id);

    // Sign and publish OTA
    const signature = signPayload(featureName);
    const otaPayload = {
      featureId: normalizeFeatureId(featureName),
      action: 'ENABLE',
      nonce: nonce,
      exp: Math.floor(expiresAt.getTime() / 1000),
      sig: signature
    };

    const topic = `vehicle/${vin}/cmd`;

    mqttClient.publish(
      topic,
      JSON.stringify(otaPayload),
      { qos: 1 },
      (err) => {
        if (err) {
          console.error('MQTT publish error:', err);
        } else {
          console.log('OTA published to:', topic);
          updateJobStatus(job.id, 'pushed');
        }
      }
    );

    // Set timeout for ACK
    setupAckTimeout(job.id, vin, featureName, nonce);

    console.log('==========================================\n');

    return job;

  } catch (err) {
    console.error('Activation service error:', err);
    throw err;
  }
}

// ============ SETUP ACK TIMEOUT ============
function setupAckTimeout(jobId, vin, featureName, nonce) {
  const timeoutId = setTimeout(async () => {
    try {
      console.log(`ACK timeout for job ${jobId}`);

      const { data: job } = await supabase
        .from('activation_jobs')
        .select('id, status')
        .eq('id', jobId)
        .single();

      if (!job) return;

      // Mark job as failed if no ACK received
      console.log('No ACK received - marking as failed');

      await supabase
        .from('activation_jobs')
        .update({ status: 'failed' })
        .eq('id', jobId);

      await supabase
        .from('vehicle_features')
        .update({ status: 'failed' })
        .eq('vin', vin)
        .eq('feature_name', featureName);

      Logger.logActivation(jobId, vin, featureName, 'ENABLE', 'failed', 0);

    } catch (err) {
      console.error('Error in ACK timeout handler:', err);
    }

    // Cleanup
    activeTimeouts.delete(nonce);

  }, 120000); // 120 seconds

  activeTimeouts.set(nonce, timeoutId);
}

// ============ UPDATE JOB STATUS ============
async function updateJobStatus(jobId, status) {
  try {
    await supabase
      .from('activation_jobs')
      .update({
        status: status,
        updated_at: new Date().toISOString()
      })
      .eq('id', jobId);

    console.log(`Job status updated to: ${status}`);
  } catch (err) {
    console.error('Error updating job status:', err);
  }
}

// ============================================================
// AUTHENTICATION ENDPOINTS
// ============================================================

app.post('/api/register', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ success: false, message: 'Phone and password required' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const { error } = await supabase
      .from('users')
      .insert({ phone, password: hashedPassword });

    if (error) throw error;

    res.status(201).json({ success: true, message: 'User registered' });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .single();

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = generateToken(user.phone);

    res.json({
      success: true,
      token,
      user: { phone: user.phone, vin: user.vin_number }
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/register-vin', authenticateToken, async (req, res) => {
  try {
    const { vin_number } = req.body;
    const phone = req.user.phone;

    if (!vin_number) {
      return res.status(400).json({ success: false, message: 'VIN required' });
    }

    const { data } = await supabase
      .from('users')
      .update({ vin_number })
      .eq('phone', phone)
      .select()
      .single();

    res.json({ success: true, user: { phone: data.phone, vin: data.vin_number } });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// FEATURES ENDPOINTS
// ============================================================

app.get('/api/features', async (req, res) => {
  try {
    const { data: features } = await supabase
      .from('features')
      .select('*')
      .order('created_at', { ascending: true });

    res.json({ success: true, data: features, count: features.length });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// PAYMENT ENDPOINTS
// ============================================================

// Get Stripe config
app.get('/api/stripe/config', (req, res) => {
  res.json({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
  });
});

app.post('/api/purchase', authenticateToken, async (req, res) => {
  try {
    const { vehicleId, featureName } = req.body;
    const phone = req.user.phone;

    console.log('\n==========================================');
    console.log('PURCHASE REQUEST');
    console.log('==========================================');
    console.log({ phone, vehicleId, featureName });

    const { data: feature } = await supabase
      .from('features')
      .select('*')
      .eq('feature_name', featureName)
      .single();

    if (!feature) throw new Error('Feature not found');

    const { data: user } = await supabase
      .from('users')
      .select('vin_number')
      .eq('phone', phone)
      .single();

    if (user.vin_number !== vehicleId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    // Create Stripe PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(feature.price * 100),
      currency: 'inr',
      description: `${featureName} for ${vehicleId}`
    });

    const { data: order } = await supabase
      .from('vehicle_features')
      .insert({
        phone: phone,
        vin: vehicleId,
        feature_name: featureName,
        amount: feature.price,
        currency: 'inr',
        payment_intent_id: paymentIntent.id,
        payment_status: 'pending',
        status: 'pending',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    Logger.logPayment(paymentIntent.id, phone, vehicleId, feature.price, 'initiated');

    console.log('==========================================\n');

    res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: feature.price
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/payment/success', authenticateToken, async (req, res) => {
  try {
    const { paymentIntentId, featureName } = req.body;
    const phone = req.user.phone;

    console.log('\n ==========================================');
    console.log('PAYMENT SUCCESS');
    console.log('==========================================');
    console.log({ paymentIntentId, featureName, phone });

    // Validate input
    if (!paymentIntentId || !featureName) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing paymentIntentId or featureName' 
      });
    }

    // Get user VIN
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('vin_number')
      .eq('phone', phone)
      .single();

    if (userError || !user?.vin_number) {
      console.error('User lookup error:', userError?.message);
      return res.status(404).json({ success: false, message: 'VIN not registered' });
    }

    const vin = user.vin_number;
    console.log('User VIN:', vin);

    // Calculate validity (1 year from now by default)
    const validityDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

    // Check if purchase record exists
    const { data: existingPurchase, error: fetchError } = await supabase
      .from('vehicle_features')
      .select('*')
      .eq('payment_intent_id', paymentIntentId)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      console.error('Fetch error:', fetchError.message);
      return res.status(500).json({ success: false, error: fetchError.message });
    }

    if (!existingPurchase) {
      console.error('No purchase found with paymentIntentId:', paymentIntentId);
      return res.status(404).json({ 
        success: false, 
        message: 'Payment record not found' 
      });
    }

    console.log('Existing purchase found:', existingPurchase.id);

    // Update payment status
    const { data: purchase, error: updateError } = await supabase
      .from('vehicle_features')
      .update({
        payment_status: 'success',
        status: 'processing',
        updated_at: new Date().toISOString()
      })
      .eq('payment_intent_id', paymentIntentId)
      .select()
      .single();

    if (updateError || !purchase) {
      console.error('Update error:', updateError?.message);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to update payment status',
        error: updateError?.message
      });
    }

    console.log('Payment status updated');
    console.log('NOTE: Validity column will be set once added to database');

    Logger.logPayment(paymentIntentId, phone, vin, purchase.amount, 'success');

    // ============ TRIGGER ACTIVATION ============
    await triggerActivation(vin, featureName, purchase.id);

    console.log('==========================================\n');

    res.json({
      success: true,
      message: 'Payment recorded, activation triggered',
      purchaseId: purchase.id
    });

  } catch (err) {
    console.error('Payment success error:', err);
    Logger.logPayment(req.body.paymentIntentId, req.user.phone, '', 0, 'failed');
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// WEBHOOK ENDPOINTS
// ============================================================

app.post('/api/webhook/stripe', express.raw({type: 'application/json'}), async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    console.log('Stripe webhook received:', event.type);

    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object;
      console.log('Payment succeeded:', paymentIntent.id);

      await supabase
        .from('vehicle_features')
        .update({ payment_status: 'success' })
        .eq('payment_intent_id', paymentIntent.id);
    }

    res.json({ success: true });

  } catch (err) {
    console.error('WEBHOOK ERROR:', err);
    res.status(400).json({ error: err.message });
  }
});

// ============================================================
// ENTITLEMENTS ENDPOINT
// ============================================================

app.get('/api/entitlements', authenticateToken, async (req, res) => {
  try {
    const phone = req.user.phone;
    const vehicleId = req.query.vehicleId;

    const { data: user } = await supabase
      .from('users')
      .select('vin_number')
      .eq('phone', phone)
      .single();

    if (!user) return res.status(404).json({ success: false });

    const vin = vehicleId || user.vin_number;

    const { data: purchases } = await supabase
      .from('vehicle_features')
      .select('*')
      .eq('vin', vin)
      .order('created_at', { ascending: false });

    const entitlements = (purchases || []).map(p => {
      let state = 'NOT_PURCHASED';
      if (p.payment_status === 'success') {
        state = (p.status === 'enabled' || p.status === 'activated') ? 'ACTIVE' : 'PURCHASED_PENDING_ACTIVATION';
      }
      return {
        id: p.id,
        featureName: p.feature_name,
        paymentIntentId: p.payment_intent_id,
        purchaseDate: p.created_at,
        paymentStatus: p.payment_status,
        entitlementState: state,
        status: p.status,
        amount: p.amount,
        enabledDate: p.enabled_date,
        validity: p.validity
      };
    });

    res.json({ success: true, vin, entitlements });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// MQTT HANDLERS
// ============================================================

mqttClient.on('connect', () => {
  console.log('Connected to MQTT broker');
  mqttClient.subscribe('vehicle/+/status');
  mqttClient.subscribe('vehicle/+/ack');
  console.log(' Subscribed to: vehicle/+/status, vehicle/+/ack');
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    const vin = topic.split('/')[1];

    console.log('\n ==========================================');
    console.log(' MQTT MESSAGE RECEIVED');
    console.log(' ==========================================');
    console.log('   Topic:', topic);
    console.log('   Payload:', payload);

    // ============ STATUS RESPONSE ============
    if (topic.includes('/status')) {
      // Get feature name - try to match case-insensitive in database
      let featureName = payload.featureName;
      
      console.log('Received feature name:', featureName);

      if (payload.success === true) {
        console.log('Feature activation successful');

        // Get all features for this VIN to find a match
        const { data: allFeatures } = await supabase
          .from('vehicle_features')
          .select('*')
          .eq('vin', vin)
          .eq('payment_status', 'success')
          .eq('status', 'processing');

        if (!allFeatures || allFeatures.length === 0) {
          console.log('ERROR: No pending features found for VIN:', vin);
          return;
        }

        // Try to match the feature name (case-insensitive, handle underscores vs spaces)
        const normalizeString = (str) => str.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
        const receivedNameNormalized = normalizeString(featureName);

        const matchedFeature = allFeatures.find(f => {
          const dbNameNormalized = normalizeString(f.feature_name);
          return dbNameNormalized === receivedNameNormalized;
        });

        if (!matchedFeature) {
          console.log('ERROR: No matching feature found');
          console.log('Received normalized:', receivedNameNormalized);
          console.log('Database features:', allFeatures.map(f => `${f.feature_name} (normalized: ${normalizeString(f.feature_name)})`));
          return;
        }

        featureName = matchedFeature.feature_name;
        console.log('Matched feature name:', featureName);
        console.log('Matched feature ID:', matchedFeature.id);

        const { data: purchaseList, error: updateError } = await supabase
          .from('vehicle_features')
          .update({
            status: 'enabled',
            updated_at: new Date().toISOString()
          })
          .eq('id', matchedFeature.id)
          .select();

        if (updateError) {
          console.log('ERROR updating vehicle_features:', updateError?.message);
          return;
        }

        if (!purchaseList || purchaseList.length === 0) {
          console.log('ERROR: No rows updated');
          return;
        }

        const purchase = purchaseList[0];

        await supabase
          .from('activation_jobs')
          .update({ status: 'enabled', updated_at: new Date().toISOString() })
          .eq('vehicle_features_id', matchedFeature.id);

        console.log('Feature ENABLED');
        Logger.logActivation(purchase.id, vin, featureName, 'ENABLE', 'enabled', 0);

      } else if (payload.success === false) {
        console.log('Feature activation failed');

        await supabase
          .from('vehicle_features')
          .update({ status: 'failed' })
          .eq('vin', vin)
          .eq('feature_name', featureName);

        Logger.logActivation(0, vin, featureName, 'ENABLE', 'failed', 0);
      }
    }

    // ============ ACK RESPONSE ============
    else if (topic.includes('/ack')) {
      const { nonce, result, featureId } = payload;

      console.log('ACK received from device');

      const { data: job } = await supabase
        .from('activation_jobs')
        .select('*')
        .eq('nonce', nonce)
        .eq('vin', vin)
        .single();

      if (!job) {
        console.log('No job found for nonce');
        return;
      }

      if (result === 'SUCCESS' || result === true) {
        console.log('ACK SUCCESS');

        await supabase
          .from('activation_jobs')
          .update({ status: 'acked', acked_at: new Date().toISOString() })
          .eq('id', job.id);

        // Clear timeout
        if (activeTimeouts.has(nonce)) {
          clearTimeout(activeTimeouts.get(nonce));
          activeTimeouts.delete(nonce);
        }

      } else {
        console.log('ACK FAILED');
        await supabase
          .from('activation_jobs')
          .update({ status: 'failed', error_message: payload.error })
          .eq('id', job.id);
      }
    }

    console.log('==========================================\n');

  } catch (err) {
    console.error('MQTT handler error:', err);
  }
});

mqttClient.on('error', (err) => {
  console.error('MQTT error:', err);
});

// ============================================================
// METRICS ENDPOINT
// ============================================================

app.get('/api/metrics', (req, res) => {
  const metrics = Logger.getMetrics();
  res.json({ success: true, metrics });
});

// ============================================================
// STARTUP
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});