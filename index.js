const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
    origin: process.env.FRONTEND_URL,
    credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Utility function to generate MD5 hash
const getMd5Hash = (input) => {
    return crypto.createHash('md5').update(input).digest('hex').toUpperCase();
};

// Store payments in memory (replace with database in production)
const payments = {};

/**
 * Endpoint 1: Generate hash for payment initialization
 * PayHere requires hash = md5(merchant_id + order_id + amount + currency + md5(merchant_secret)) [citation:1][citation:3]
 */
app.get('/api/payment/hash', (req, res) => {
    try {
        const { amount } = req.query;
        
        if (!amount) {
            return res.status(400).json({ error: 'Amount is required' });
        }

        // Generate unique order ID
        const orderId = `ORDER_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const currency = 'LKR';
        const formattedAmount = parseFloat(amount).toFixed(2);

        // Calculate hash according to PayHere specification [citation:3]
        const hash = getMd5Hash(
            process.env.MERCHANT_ID +
            orderId +
            formattedAmount +
            currency +
            getMd5Hash(process.env.MERCHANT_SECRET)
        );

        res.json({
            orderId,
            hash,
            amount: formattedAmount,
            currency,
            merchantId: process.env.MERCHANT_ID
        });
    } catch (error) {
        console.error('Hash generation error:', error);
        res.status(500).json({ error: 'Failed to generate hash' });
    }
});

/**
 * Endpoint 2: Payment notification webhook (called by PayHere) [citation:1][citation:3]
 * This URL must be publicly accessible
 */
app.post('/api/payment/notify', (req, res) => {
    try {
        const {
            merchant_id,
            order_id,
            payment_id,
            payhere_amount,
            payhere_currency,
            status_code,
            md5sig,
            custom_1, // Can store user ID
            method,
            status_message,
            card_holder_name,
            card_no,
            card_expiry
        } = req.body;

        console.log('Payment notification received:', req.body);

        // Verify MD5 signature to ensure authenticity [citation:1][citation:3]
        const localMd5sig = getMd5Hash(
            merchant_id +
            order_id +
            payhere_amount +
            payhere_currency +
            status_code +
            getMd5Hash(process.env.MERCHANT_SECRET)
        );

        // Check if signature matches
        if (localMd5sig !== md5sig) {
            console.error('MD5 signature mismatch');
            return res.status(400).json({ error: 'Invalid signature' });
        }

        // Store payment information (use database in production)
        payments[order_id] = {
            order_id,
            payment_id,
            amount: payhere_amount,
            currency: payhere_currency,
            status_code,
            status_message,
            method,
            card_holder_name,
            card_no,
            card_expiry,
            customer_id: custom_1,
            verified: true,
            timestamp: new Date().toISOString()
        };

        // Return success to PayHere
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Notification processing error:', error);
        res.status(500).json({ error: 'Failed to process notification' });
    }
});

/**
 * Endpoint 3: Check payment status (called by frontend) [citation:1]
 */
app.get('/api/payment/status/:orderId', (req, res) => {
    try {
        const { orderId } = req.params;
        
        const payment = payments[orderId];
        
        if (payment) {
            res.json({
                success: payment.status_code === '2',
                status: payment.status_code,
                payment
            });
        } else {
            res.json({
                success: false,
                status: 'pending',
                message: 'Payment not found'
            });
        }
    } catch (error) {
        console.error('Status check error:', error);
        res.status(500).json({ error: 'Failed to check payment status' });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});