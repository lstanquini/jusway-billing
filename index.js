const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

// Configurações
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Middleware
app.use(cors());
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Rota de teste
app.get('/', (req, res) => {
  res.json({ status: 'JusWay Backend rodando!' });
});

// Webhook do Stripe
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  
  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    
    console.log('Webhook recebido:', event.type);
    
    // Processar evento
    if (event.type === 'customer.subscription.created') {
      const subscription = event.data.object;
      
      // Buscar metadata do produto
      const price = await stripe.prices.retrieve(
        subscription.items.data[0].price.id,
        { expand: ['product'] }
      );
      
      const metadata = price.product.metadata;
      
      // Salvar no Supabase
      await supabase.from('subscriptions').upsert({
        stripe_subscription_id: subscription.id,
        stripe_customer_id: subscription.customer,
        status: subscription.status,
        plan_id: price.lookup_key || 'unknown',
        limits: metadata,
        current_period_end: new Date(subscription.current_period_end * 1000)
      });
    }
    
    res.json({ received: true });
  } catch (err) {
    console.error('Erro:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});