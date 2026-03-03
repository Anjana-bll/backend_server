// backend/logger.js

const fs = require('fs');
const path = require('path');

class Logger {
  constructor() {
    this.logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir);
    }
  }

  // ============ LOG PAYMENT EVENT ============
  logPayment(orderId, phone, vin, amount, status) {
    const log = {
      timestamp: new Date().toISOString(),
      event: 'PAYMENT',
      orderId,
      phone,
      vin,
      amount,
      status  // 'success', 'failed', 'pending'
    };

    this._writeLog('payments.json', log);
    console.log('Payment logged:', log);
  }

  // ============ LOG ACTIVATION EVENT ============
  logActivation(jobId, vin, featureName, action, status, duration) {
    const log = {
      timestamp: new Date().toISOString(),
      event: 'ACTIVATION',
      jobId,
      vin,
      featureName,
      action,
      status,  // 'created', 'pushed', 'acked', 'activated', 'failed'
      duration_ms: duration
    };

    this._writeLog('activations.json', log);
    console.log('Activation logged:', log);
  }

  // ============ LOG RETRY EVENT ============
  logRetry(jobId, vin, featureName, retryCount, reason) {
    const log = {
      timestamp: new Date().toISOString(),
      event: 'RETRY',
      jobId,
      vin,
      featureName,
      retryCount,
      reason
    };

    this._writeLog('retries.json', log);
    console.log('Retry logged:', log);
  }

  // ============ WRITE TO FILE ============
  _writeLog(filename, logEntry) {
    const filepath = path.join(this.logDir, filename);
    
    try {
      let data = [];
      if (fs.existsSync(filepath)) {
        const content = fs.readFileSync(filepath, 'utf8');
        data = JSON.parse(content);
      }
      
      data.push(logEntry);
      fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Error writing log:', err);
    }
  }

  // ============ GET METRICS ============
  getMetrics() {
    const metrics = {};

    // Read all log files
    const files = fs.readdirSync(this.logDir);
    files.forEach(file => {
      const content = fs.readFileSync(path.join(this.logDir, file), 'utf8');
      const logs = JSON.parse(content);

      metrics[file] = {
        total: logs.length,
        today: logs.filter(l => 
          new Date(l.timestamp).toDateString() === new Date().toDateString()
        ).length
      };

      // Calculate activation success rate
      if (file === 'activations.json') {
        const successful = logs.filter(l => l.status === 'activated').length;
        metrics.activation_success_rate = (successful / logs.length * 100).toFixed(2) + '%';
      }
    });

    return metrics;
  }
}

module.exports = new Logger();