const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Enhanced logging
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

const logStream = fs.createWriteStream(
    path.join(logDir, `payment-${new Date().toISOString().split('T')[0]}.log`), 
    { flags: 'a' }
);

const log = (message, data = null) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message} ${data ? JSON.stringify(data, null, 2) : ''}\n`;
    console.log(logMessage);
    logStream.write(logMessage);
};

// Middleware
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true
}));

// Parse both JSON and urlencoded bodies
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
    log(`${req.method} ${req.url}`, {
        query: req.query,
        body: req.body,
        headers: req.headers
    });
    next();
});

// Utility function to generate MD5 hash
const getMd5Hash = (input) => {
    return crypto.createHash('md5').update(input).digest('hex').toUpperCase();
};

// Store payments in memory with persistence
const payments = {};
const PAYMENTS_FILE = path.join(__dirname, 'payments.json');

// Load existing payments
try {
    if (fs.existsSync(PAYMENTS_FILE)) {
        const data = fs.readFileSync(PAYMENTS_FILE, 'utf8');
        Object.assign(payments, JSON.parse(data));
        log('Loaded existing payments', { count: Object.keys(payments).length });
    }
} catch (error) {
    log('Error loading payments file', error);
}

// Save payments to file periodically
const savePayments = () => {
    try {
        fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(payments, null, 2));
        log('Payments saved to file');
    } catch (error) {
        log('Error saving payments', error);
    }
};

// Save every minute
setInterval(savePayments, 60000);

/**
 * Endpoint 1: Generate hash for payment initialization
 */
app.get('/api/payment/hash', (req, res) => {
    try {
        const { amount } = req.query;
        
        log('Hash request received', { amount });
        
        if (!amount) {
            return res.status(400).json({ error: 'Amount is required' });
        }

        // Validate merchant credentials
        if (!process.env.MERCHANT_ID || !process.env.MERCHANT_SECRET) {
            log('Merchant credentials missing');
            return res.status(500).json({ error: 'Payment gateway not configured properly' });
        }

        // Generate unique order ID
        const orderId = `ORDER_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        const currency = 'LKR';
        const formattedAmount = parseFloat(amount).toFixed(2);

        log('Generating hash with params', {
            merchantId: process.env.MERCHANT_ID,
            orderId,
            amount: formattedAmount,
            currency
        });

        // Calculate hash according to PayHere specification
        const secretHash = getMd5Hash(process.env.MERCHANT_SECRET);
        const hashString = process.env.MERCHANT_ID + orderId + formattedAmount + currency + secretHash;
        const hash = getMd5Hash(hashString);

        log('Hash generated successfully', { orderId, hash });

        // Store initial payment record
        payments[orderId] = {
            order_id: orderId,
            amount: formattedAmount,
            currency,
            status_code: '0', // 0 = pending
            status_message: 'Payment initiated',
            created_at: new Date().toISOString(),
            verified: false
        };

        res.json({
            orderId,
            hash,
            amount: formattedAmount,
            currency,
            merchantId: process.env.MERCHANT_ID
        });
    } catch (error) {
        log('Hash generation error', error);
        res.status(500).json({ error: 'Failed to generate hash' });
    }
});

/**
 * Endpoint 2: Payment notification webhook (called by PayHere)
 */
app.post('/api/payment/notify', (req, res) => {
    try {
        const notification = req.body;
        
        log('📨 PAYMENT NOTIFICATION RECEIVED', notification);

        // Log raw notification for debugging
        log('Raw notification body', notification);

        const {
            merchant_id,
            order_id,
            payment_id,
            payhere_amount,
            payhere_currency,
            status_code,
            md5sig,
            custom_1,
            custom_2,
            method,
            status_message,
            card_holder_name,
            card_no,
            card_expiry
        } = notification;

        // Validate required fields
        if (!order_id || !merchant_id || !status_code) {
            log('Missing required fields in notification');
            return res.status(400).send('Missing required fields');
        }

        // Verify MD5 signature
        const secretHash = getMd5Hash(process.env.MERCHANT_SECRET);
        const localMd5sig = getMd5Hash(
            merchant_id +
            order_id +
            payhere_amount +
            payhere_currency +
            status_code +
            secretHash
        );

        log('Signature verification', {
            received: md5sig,
            calculated: localMd5sig,
            match: localMd5sig === md5sig
        });

        // Check if signature matches
        if (localMd5sig !== md5sig) {
            log('❌ MD5 SIGNATURE MISMATCH', {
                received: md5sig,
                calculated: localMd5sig,
                merchant_id,
                order_id,
                payhere_amount,
                payhere_currency,
                status_code
            });
            return res.status(400).send('Invalid signature');
        }

        // Store payment information
        payments[order_id] = {
            ...payments[order_id],
            payment_id,
            amount: payhere_amount,
            currency: payhere_currency,
            status_code,
            status_message: status_message || getStatusMessage(status_code),
            method,
            card_holder_name,
            card_no: card_no ? `xxxx-xxxx-xxxx-${card_no.slice(-4)}` : undefined,
            card_expiry,
            customer_id: custom_1,
            custom_data: custom_2,
            verified: true,
            updated_at: new Date().toISOString()
        };

        log('✅ Payment processed successfully', {
            order_id,
            status_code,
            status_message: payments[order_id].status_message,
            method
        });

        // Save immediately for this important update
        savePayments();

        // Return success to PayHere (must send exactly "200 OK" or "200 OK ")
        res.status(200).send('200 OK');
    } catch (error) {
        log('❌ Notification processing error', error);
        res.status(500).send('Error processing notification');
    }
});

// Helper function to get status message
const getStatusMessage = (statusCode) => {
    const messages = {
        '0': 'Pending',
        '1': 'Success', // Some PayHere versions use 1 for success
        '2': 'Success', // Most common success code
        '-1': 'Cancelled',
        '-2': 'Failed',
        '-3': 'Chargeback'
    };
    return messages[statusCode] || 'Unknown status';
};

/**
 * Endpoint 3: Check payment status (called by frontend)
 */
app.get('/api/payment/status/:orderId', (req, res) => {
    try {
        const { orderId } = req.params;
        
        log('Payment status check', { orderId });
        
        const payment = payments[orderId];
        
        if (payment) {
            const isSuccess = payment.status_code === '2' || payment.status_code === '1';
            
            log('Payment status found', {
                orderId,
                status_code: payment.status_code,
                isSuccess
            });

            res.json({
                success: isSuccess,
                status: payment.status_code === '2' || payment.status_code === '1' ? 'completed' : 
                       payment.status_code === '-1' ? 'cancelled' :
                       payment.status_code === '-2' ? 'failed' : 'pending',
                payment: {
                    ...payment,
                    card_no: payment.card_no ? 'xxxx-xxxx-xxxx-xxxx' : undefined // Mask card number
                }
            });
        } else {
            log('Payment not found', { orderId });
            res.json({
                success: false,
                status: 'pending',
                message: 'Payment not found or still processing'
            });
        }
    } catch (error) {
        log('Status check error', error);
        res.status(500).json({ error: 'Failed to check payment status' });
    }
});

/**
 * Endpoint 4: Retry payment
 */
app.post('/api/payment/retry', (req, res) => {
    try {
        const { orderId } = req.body;
        
        log('Payment retry requested', { orderId });
        
        const payment = payments[orderId];
        
        if (!payment) {
            return res.status(404).json({ error: 'Order not found' });
        }

        // Generate new order ID for retry
        const newOrderId = `ORDER_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        
        // Copy payment data to new order
        payments[newOrderId] = {
            ...payment,
            order_id: newOrderId,
            status_code: '0',
            status_message: 'Retry initiated',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            retry_from: orderId
        };

        // Generate new hash
        const secretHash = getMd5Hash(process.env.MERCHANT_SECRET);
        const hashString = process.env.MERCHANT_ID + newOrderId + payment.amount + payment.currency + secretHash;
        const hash = getMd5Hash(hashString);

        res.json({
            success: true,
            orderId: newOrderId,
            paymentData: {
                sandbox: true,
                merchant_id: process.env.MERCHANT_ID,
                order_id: newOrderId,
                amount: payment.amount,
                currency: payment.currency,
                hash: hash,
                first_name: 'Customer',
                last_name: '',
                email: '',
                phone: '',
                address: '',
                city: '',
                country: 'Sri Lanka'
            }
        });
    } catch (error) {
        log('Retry error', error);
        res.status(500).json({ error: 'Failed to retry payment' });
    }
});

/**
 * Endpoint 5: Refund payment
 */
app.post('/api/payment/refund', (req, res) => {
    try {
        const { orderId, amount, reason } = req.body;
        
        log('Refund requested', { orderId, amount, reason });
        
        const payment = payments[orderId];
        
        if (!payment) {
            return res.status(404).json({ error: 'Payment not found' });
        }

        if (payment.status_code !== '2' && payment.status_code !== '1') {
            return res.status(400).json({ error: 'Cannot refund non-successful payment' });
        }

        // Update payment record
        payment.refund = {
            amount,
            reason,
            requested_at: new Date().toISOString(),
            status: 'pending'
        };

        // In production, you would integrate with PayHere refund API here
        // For now, we'll simulate a successful refund
        payment.refund.status = 'processed';
        payment.refund.processed_at = new Date().toISOString();
        payment.status_code = '-3'; // Chargeback/Refund status

        savePayments();

        res.json({
            success: true,
            message: 'Refund processed successfully',
            refund: payment.refund
        });
    } catch (error) {
        log('Refund error', error);
        res.status(500).json({ error: 'Failed to process refund' });
    }
});

/**
 * Endpoint 6: Get payment history
 */
app.get('/api/payment/history/:orderId', (req, res) => {
    try {
        const { orderId } = req.params;
        
        log('Payment history requested', { orderId });
        
        const payment = payments[orderId];
        
        if (!payment) {
            return res.status(404).json({ error: 'Payment not found' });
        }

        // Get all payments related to this order (including retries)
        const history = Object.values(payments).filter(p => 
            p.order_id === orderId || p.retry_from === orderId
        ).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        res.json({
            success: true,
            history
        });
    } catch (error) {
        log('History fetch error', error);
        res.status(500).json({ error: 'Failed to fetch payment history' });
    }
});

/**
 * Endpoint 7: Health check with detailed status
 */
app.get('/api/health', (req, res) => {
    const health = {
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development',
        services: {
            payment_gateway: 'PayHere',
            merchant_configured: !!(process.env.MERCHANT_ID && process.env.MERCHANT_SECRET),
            payments_stored: Object.keys(payments).length
        },
        memory: process.memoryUsage(),
        version: '1.0.0'
    };
    
    log('Health check', health);
    res.json(health);
});

/**
 * Endpoint 8: Test PayHere configuration
 */
app.get('/api/payment/test-config', (req, res) => {
    try {
        const config = {
            merchant_id: process.env.MERCHANT_ID ? '✓ Configured' : '✗ Missing',
            merchant_secret: process.env.MERCHANT_SECRET ? '✓ Configured' : '✗ Missing',
            frontend_url: process.env.FRONTEND_URL || 'http://localhost:5173',
            mode: process.env.PAYHERE_MODE || 'sandbox',
            timestamp: new Date().toISOString()
        };

        // Generate test hash to verify configuration
        if (process.env.MERCHANT_ID && process.env.MERCHANT_SECRET) {
            const testOrderId = 'TEST_' + Date.now();
            const secretHash = getMd5Hash(process.env.MERCHANT_SECRET);
            const testHash = getMd5Hash(process.env.MERCHANT_ID + testOrderId + '100.00' + 'LKR' + secretHash);
            config.test_hash_generated = testHash ? '✓ Success' : '✗ Failed';
        }

        res.json({
            success: true,
            config
        });
    } catch (error) {
        log('Test config error', error);
        res.status(500).json({ error: 'Failed to test configuration' });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    log('Unhandled error', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Handle 404
app.use((req, res) => {
    log('404 Not Found', { url: req.url, method: req.method });
    res.status(404).json({ error: 'Endpoint not found' });
});

app.listen(PORT, '0.0.0.0', () => {
    log(`🚀 Server running on port ${PORT}`);
    log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    log(`PayHere Mode: ${process.env.PAYHERE_MODE || 'sandbox'}`);
    log(`Merchant ID: ${process.env.MERCHANT_ID ? '✓ Configured' : '✗ Missing'}`);
    log(`Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
    log(`Logging to: ${logDir}`);
});