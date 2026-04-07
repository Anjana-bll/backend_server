const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mqtt = require('mqtt');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const Razorpay = require('razorpay');
const Logger = require('./logger');

const app = express();
app.use(express.json());
app.use(cors());

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
console.log("Razorpay KEY:", process.env.RAZORPAY_KEY_ID);
console.log("Razorpay SECRET:", process.env.RAZORPAY_KEY_SECRET ? "Loaded" : "Missing");

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

//for razorpay webhook signature verification
function verifyRazorpaySignature({
  orderId,
  paymentId,
  signature,
}) {
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  return expectedSignature === signature;
}

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

app.post('/api/purchase', authenticateToken, async (req, res) => {
  try {
    const { vehicleId, featureName } = req.body;
    const phone = req.user.phone;

    console.log('Incoming purchase request');

    const { data: feature, error: featureError } = await supabase
      .from('features')
      .select('*')
      .eq('feature_name', featureName)
      .single();

    console.log('Feature:', feature, 'Error:', featureError);

    // const amountInPaise = Math.round(feature.price * 100);
    const amount = Math.round(feature.price*100, 100);

    console.log('Creating Razorpay order...');

    const razorpayOrder = await razorpay.orders.create({
      amount: amount,
      currency: 'INR',
      receipt: `receipt_${vehicleId}_${Date.now()}`,
    });

    console.log('Razorpay Order:', razorpayOrder);

    const { data: purchase, error: insertError } = await supabase
      .from('vehicle_features')
      .insert({
        phone: phone,
        vin: vehicleId,
        feature_name: featureName,
        amount: amount,
        currency: 'inr',
        razorpay_order_id: razorpayOrder.id,
        payment_status: 'pending',
        status: 'pending',
      })
      .select()
      .single();

    console.log('DB INSERT:', purchase, insertError);

    if (insertError) {
      console.error('DB ERROR:', insertError);
      return res.status(500).json({
        success: false,
        error: insertError.message,
      });
    }

    res.json({
      success: true,
      key: process.env.RAZORPAY_KEY_ID,
      orderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
    });

  } catch (err) {
    console.error('❌ PURCHASE ERROR:', err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

//razorpay payment flow:
app.post('/api/payment/success', authenticateToken, async (req, res) => {
  try {
    const {
      razorpayPaymentId,
      razorpayOrderId,
      razorpaySignature,
      featureName,
    } = req.body;

    const phone = req.user.phone;

    console.log('\n==========================================');
    console.log('PAYMENT SUCCESS / VERIFY');
    console.log('==========================================');
    console.log({
      razorpayPaymentId,
      razorpayOrderId,
      featureName,
      phone,
    });

    if (
      !razorpayPaymentId ||
      !razorpayOrderId ||
      !razorpaySignature ||
      !featureName
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Missing razorpayPaymentId, razorpayOrderId, razorpaySignature or featureName',
      });
    }

    const isSignatureValid = verifyRazorpaySignature({
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      signature: razorpaySignature,
    });

    if (!isSignatureValid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment signature',
      });
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('vin_number')
      .eq('phone', phone)
      .single();

    if (userError || !user?.vin_number) {
      return res.status(404).json({
        success: false,
        message: 'VIN not registered',
      });
    }

    const vin = user.vin_number;

    const { data: existingPurchase, error: fetchError } = await supabase
      .from('vehicle_features')
      .select('*')
      .eq('razorpay_order_id', razorpayOrderId)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      return res.status(500).json({
        success: false,
        error: fetchError.message,
      });
    }

    if (!existingPurchase) {
      return res.status(404).json({
        success: false,
        message: 'Payment record not found',
      });
    }

    const { data: purchase, error: updateError } = await supabase
      .from('vehicle_features')
      .update({
        razorpay_payment_id: razorpayPaymentId,
        razorpay_signature: razorpaySignature,
        payment_status: 'success',
        status: 'processing',
        updated_at: new Date().toISOString(),
      })
      .eq('razorpay_order_id', razorpayOrderId)
      .select()
      .single();

    if (updateError || !purchase) {
      return res.status(500).json({
        success: false,
        message: 'Failed to update payment status',
        error: updateError?.message,
      });
    }

    Logger.logPayment(
      razorpayPaymentId,
      phone,
      vin,
      purchase.amount,
      'success'
    );

    await triggerActivation(vin, featureName, purchase.id);

    console.log('==========================================\n');

    res.json({
      success: true,
      message: 'Payment verified, recorded and activation triggered',
      purchaseId: purchase.id,
    });
  } catch (err) {
    console.error('Payment verification error:', err);
    Logger.logPayment(req.body.razorpayPaymentId || '', req.user.phone, '', 0, 'failed');
    res.status(500).json({
      success: false,
      error: err.message,
    });
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
        razorpayOrderId: p.razorpay_order_id,
        razorpayPaymentId: p.razorpay_payment_id,
        purchaseDate: p.created_at,
        paymentStatus: p.payment_status,
        entitlementState: state,
        status: p.status,
        amount: p.amount,
        enabledDate: p.validity_start,
        validity: p.validity_end
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