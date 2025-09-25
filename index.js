const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
require('dotenv').config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Middleware
app.use(cors());
app.use('/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Rota de teste
app.get('/', (req, res) => {
  res.json({ 
    status: 'JusWay Billing Service', 
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Webhook do Stripe
app.post('/stripe/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  
  try {
    // 1. Valida que veio do Stripe
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    
    console.log('✅ Webhook recebido:', event.type);
    
    // 2. Para eventos de subscription, busca metadata
    if (event.type.includes('customer.subscription')) {
      const subscription = event.data.object;
      
      // Busca customer para pegar escritorio_id
      const customer = await stripe.customers.retrieve(subscription.customer);
      
      // Busca produto para pegar limites
      const price = await stripe.prices.retrieve(
        subscription.items.data[0].price.id,
        { expand: ['product'] }
      );
      
      // Monta evento enriquecido
      const enrichedEvent = {
        type: event.type,
        subscription_id: subscription.id,
        customer_id: subscription.customer,
        escritorio_id: customer.metadata?.escritorio_id || null,
        status: subscription.status,
        plan_id: price.lookup_key || price.id,
        limits: price.product.metadata || {},
        current_period_end: subscription.current_period_end,
        trial_end: subscription.trial_end
      };
      
      console.log('📦 Evento processado:', enrichedEvent);
      
      // 3. Se configurado, repassa para Base44
      if (process.env.BASE44_API_URL) {
        try {
          await fetch(`${process.env.BASE44_API_URL}/api/stripe/webhook`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Secret': process.env.BASE44_WEBHOOK_SECRET || 'secret'
            },
            body: JSON.stringify(enrichedEvent)
          });
        } catch (error) {
          console.error('Erro ao enviar para Base44:', error.message);
        }
      }
    }
    
    res.json({ received: true });
    
  } catch (err) {
    console.error('❌ Erro:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// API para criar checkout session
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { escritorio_id, email, price_id } = req.body;
    
    // Cria ou busca customer
    let customer;
    const existingCustomers = await stripe.customers.list({ email, limit: 1 });
    
    if (existingCustomers.data.length > 0) {
      customer = existingCustomers.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        metadata: {
          escritorio_id: escritorio_id
        }
      });
    }
    
    // Cria checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      line_items: [{
        price: price_id,
        quantity: 1
      }],
      mode: 'subscription',
      success_url: `${process.env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/billing/cancel`
    });
    
    res.json({ url: session.url });
    
  } catch (error) {
    console.error('Erro ao criar checkout:', error);
    res.status(500).json({ error: error.message });
  }
});

// API para criar portal do cliente
app.post('/api/create-portal', async (req, res) => {
  try {
    const { customer_id } = req.body;
    
    const session = await stripe.billingPortal.sessions.create({
      customer: customer_id,
      return_url: `${process.env.APP_URL}/billing`
    });
    
    res.json({ url: session.url });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});