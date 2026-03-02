const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mqtt = require('mqtt');
const multer = require('multer');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Supabase client
const { createClient } = require('@supabase/supabase-js');
// Stripe initialization
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Supabase client initialization
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// MQTT Client
const mqttClient = mqtt.connect(process.env.MQTT_BROKER || 'mqtt://localhost:1883');

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

// Multer for firmware upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'firmware/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// JWT Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Access token required'
    });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({
        success: false,
        message: 'Invalid or expired token'
      });
    }
    req.user = user;
    next();
  });
};

// Generate JWT Token
const generateToken = (phone) => {
  return jwt.sign({ phone }, JWT_SECRET, { expiresIn: '7d' });
};

// ============================================================
// STRIPE ENDPOINTS
// ============================================================

// Get Stripe publishable key (for Flutter initialization)
app.get('/api/stripe/config', (req, res) => {
  res.json({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
  });
});

// Create PaymentIntent - Main payment creation endpoint
app.post('/api/stripe/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'inr', description = 'Payment' } = req.body;

    // Validate amount
    if (!amount || amount <= 0) {
      return res.status(400).json({
        error: 'Invalid amount. Amount must be greater than 0'
      });
    }

    // Create PaymentIntent with Stripe
    // Amount is in smallest currency unit (paise for INR, cents for USD)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount), // Ensure integer
      currency: currency.toLowerCase(),
      description: description,
      // Enable automatic payment methods for flexibility
      automatic_payment_methods: {
        enabled: true,
      },
    });

    console.log('💳 PaymentIntent created:', paymentIntent.id);

    // Return client_secret to Flutter for payment confirmation
    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency
    });

  } catch (error) {
    console.error('❌ Error creating PaymentIntent:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/* ================= User Registration ================= */
app.post('/api/register', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ message: 'Phone and password required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 chars' });
    }

    // Check existing user
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('phone', phone)
      .maybeSingle();

    if (existingUser) {
      return res.status(400).json({ message: 'Phone already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const { error } = await supabase.from('users').insert({
      phone,
      password: hashedPassword
    });

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: 'User registered successfully'
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= User LOGIN ================= */
app.post('/api/login', async (req, res) => {
  try {
    console.log("➡️ /api/login HIT");
    console.log("BODY:", req.body);

    const { phone, password } = req.body;

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .single();

    console.log("SUPABASE USER:", user, "ERROR:", error);


    if (error || !user) {
      console.log("User not found");
      return res.status(401).json({ message: 'User not found' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      console.log("Invalid credentials");
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    let token;
    try {
      token = generateToken(user.phone);
    } catch (e) {
      console.log(`JWT ERROR: ${e}`);
      return res.status(500).json({ error: "Token generation failed" });
    }
    console.log("Login successful");
    res.json({
      success: true,
      message: 'Login successful in new server', token,
      user: {
        phone: user.phone,
        created_at: user.created_at
      }
    });

  } catch (err) {
    console.log(`Login ERROR: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/* ================= User VIN Registration ================= */
app.patch('/api/register-vin', authenticateToken, async (req, res) => {
  try {
    const { vin_number } = req.body;
    const phone = req.user.phone;

    // print vin and phone
    console.log(`➡️ /api/register-vin HIT - Phone: ${phone}, VIN: ${vin_number}`);
    if (!vin_number) {
      return res.status(400).json({
        success: false,
        message: 'VIN is required'
      });
    }

    // Check if VIN already exists
    const { data: existingVin, error: vinError } = await supabase
      .from('users')
      .select('phone')
      .eq('vin_number', vin_number)
      .maybeSingle();

    if (vinError) {
      return res.status(500).json({
        success: false,
        message: vinError.message,
      });
    }

    if (existingVin && existingVin.phone !== phone) {
      return res.status(400).json({
        success: false,
        message: 'VIN already registered by another user'
      });
    }

    // Update VIN
    const { data, error } = await supabase
      .from('users')
      .update({ vin_number })
      .eq('phone', phone)
      .select()
      .maybeSingle();

    if (error) {
      console.error('VIN UPDATE ERROR:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to register VIN',
        error: error.message
      });
    }

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      message: 'VIN registered successfully',
      user: {
        phone: data.phone,
        vin: data.vin_number
      }
    });

  } catch (err) {
    console.error('REGISTER VIN SERVER ERROR:', err);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: err.message
    });
  }
});


app.post('/api/ota-update', authenticateToken, async (req, res) => {
  try {
    const { feature } = req.body;
    const phone = req.user.phone;

    if (!feature) {
      return res.status(400).json({ message: 'Feature required' });
    }

    // Get user + VIN
    const { data: user, error } = await supabase
      .from('users')
      .select('phone, vin')
      .eq('phone', phone)
      .single();

    if (error || !user || !user.vin) {
      return res.status(400).json({ message: 'VIN not registered' });
    }

    const firmwareUrl = `https://your-server.com/firmware/${feature}.bin`;

    // Insert feature request
    const { error: insertError } = await supabase
      .from('vehicle_features')
      .insert({
        phone: user.phone,
        vin: user.vin,
        feature,
        status: 'processing',
        firmware_url: firmwareUrl
      });

    if (insertError) throw insertError;

    // Publish MQTT OTA command
    const topic = `ota/${user.vin}`;
    const message = JSON.stringify({
      feature,
      firmwareUrl,
      version: '1.0.0'
    });

    mqttClient.publish(topic, message);

    res.json({
      success: true,
      message: 'OTA update triggered',
      vin: user.vin,
      feature
    });

  } catch (err) {
    console.error('OTA ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});


// Firmware upload
app.post('/api/upload-firmware', upload.single('firmware'), (req, res) => {
  res.json({ url: req.file.path });
});

// Firmware download
app.get('/firmware/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'firmware', req.params.filename);
  res.download(filePath);
});

// MQTT handling
mqttClient.on('connect', () => {
  console.log('Connected to MQTT broker');
  mqttClient.subscribe('ota/status/+');
});

mqttClient.on('connect', () => {
  console.log('✅ Connected to MQTT broker');
  mqttClient.subscribe('ota/status/+');
});

mqttClient.on('message', async (topic, message) => {
  try {
    const vin = topic.split('/')[2];
    const payload = JSON.parse(message.toString());
    const newStatus = payload.success ? 'enabled' : 'failed';

    const { error } = await supabase
      .from('vehicle_features')
      .update({ status: newStatus })
      .eq('vin', vin)
      .eq('feature', payload.feature);

    if (error) throw error;

    console.log(`OTA ${payload.feature} for ${vin} → ${newStatus}`);

  } catch (err) {
    console.error('MQTT STATUS ERROR:', err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
})