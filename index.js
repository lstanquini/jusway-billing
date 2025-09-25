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
      // Atualiza metadata se necessário
      if (!customer.metadata.escritorio_id && escritorio_id) {
        customer = await stripe.customers.update(customer.id, {
          metadata: { escritorio_id }
        });
      }
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

// API para buscar detalhes da assinatura
app.get('/api/subscription/details/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    
    // Busca assinatura ativa
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      limit: 1
    });
    
    if (subscriptions.data.length === 0) {
      return res.status(404).json({ error: 'No active subscription' });
    }
    
    const subscription = subscriptions.data[0];
    
    // Busca detalhes do produto/preço
    const price = await stripe.prices.retrieve(
      subscription.items.data[0].price.id,
      { expand: ['product'] }
    );
    
    // Busca invoices
    const invoices = await stripe.invoices.list({
      customer: customerId,
      limit: 5
    });
    
    // Monta resposta
    const response = {
      subscription: {
        stripe_subscription_id: subscription.id,
        status: subscription.status,
        plan_id: price.lookup_key || price.id,
        plan_name: price.product.name,
        price: price.unit_amount / 100,
        interval: price.recurring.interval,
        current_period_start: new Date(subscription.current_period_start * 1000),
        current_period_end: new Date(subscription.current_period_end * 1000),
        trial_end: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
        cancel_at_period_end: subscription.cancel_at_period_end,
        limits: price.product.metadata || {}
      },
      usage: {
        // Valores mockados - o Base44 deve pegar do banco dele
        users: 5,
        processes_monthly: 23,
        whatsapp_monthly: 150,
        ai_analyses_monthly: 45,
        storage_gb: 12.5
      },
      invoices: invoices.data.map(inv => ({
        id: inv.id,
        amount: inv.amount_paid / 100,
        status: inv.status,
        date: new Date(inv.created * 1000),
        invoice_pdf: inv.invoice_pdf,
        hosted_invoice_url: inv.hosted_invoice_url
      }))
    };
    
    res.json(response);
    
  } catch (error) {
    console.error('Erro ao buscar detalhes:', error);
    res.status(500).json({ error: error.message });
  }
});

// API para criar portal do cliente (atualizada)
app.post('/api/subscription/portal', async (req, res) => {
  try {
    const { customer_id, return_url } = req.body;
    
    if (!customer_id) {
      return res.status(400).json({ error: 'customer_id is required' });
    }
    
    const session = await stripe.billingPortal.sessions.create({
      customer: customer_id,
      return_url: return_url || `${process.env.APP_URL}/admin/faturamento`
    });
    
    res.json({ url: session.url });
    
  } catch (error) {
    console.error('Erro ao criar portal:', error);
    res.status(500).json({ error: error.message });
  }
});

// API para cancelar assinatura
app.post('/api/subscription/cancel', async (req, res) => {
  try {
    const { subscription_id, immediately } = req.body;
    
    if (!subscription_id) {
      return res.status(400).json({ error: 'subscription_id is required' });
    }
    
    let subscription;
    
    if (immediately) {
      // Cancelamento imediato
      subscription = await stripe.subscriptions.cancel(subscription_id);
    } else {
      // Cancelamento no fim do período
      subscription = await stripe.subscriptions.update(
        subscription_id,
        { cancel_at_period_end: true }
      );
    }
    
    res.json({ 
      success: true, 
      message: immediately 
        ? 'Assinatura cancelada imediatamente' 
        : 'Assinatura será cancelada no fim do período',
      subscription
    });
    
  } catch (error) {
    console.error('Erro ao cancelar:', error);
    res.status(500).json({ error: error.message });
  }
});

// API para reativar assinatura (antes do fim do período)
app.post('/api/subscription/reactivate', async (req, res) => {
  try {
    const { subscription_id } = req.body;
    
    if (!subscription_id) {
      return res.status(400).json({ error: 'subscription_id is required' });
    }
    
    const subscription = await stripe.subscriptions.update(
      subscription_id,
      { cancel_at_period_end: false }
    );
    
    res.json({ 
      success: true, 
      message: 'Assinatura reativada com sucesso',
      subscription
    });
    
  } catch (error) {
    console.error('Erro ao reativar:', error);
    res.status(500).json({ error: error.message });
  }
});

// API para trocar de plano
app.post('/api/subscription/change-plan', async (req, res) => {
  try {
    const { subscription_id, new_price_id } = req.body;
    
    if (!subscription_id || !new_price_id) {
      return res.status(400).json({ error: 'subscription_id and new_price_id are required' });
    }
    
    // Busca a assinatura atual
    const subscription = await stripe.subscriptions.retrieve(subscription_id);
    
    // Atualiza o item da assinatura
    const updatedSubscription = await stripe.subscriptions.update(subscription_id, {
      items: [{
        id: subscription.items.data[0].id,
        price: new_price_id
      }],
      proration_behavior: 'always_invoice' // Cria invoice com ajuste proporcional
    });
    
    res.json({ 
      success: true, 
      message: 'Plano alterado com sucesso',
      subscription: updatedSubscription
    });
    
  } catch (error) {
    console.error('Erro ao trocar plano:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📌 Webhook endpoint: /stripe/webhook`);
  console.log(`📌 APIs disponíveis:`);
  console.log(`   POST /api/create-checkout`);
  console.log(`   GET  /api/subscription/details/:customerId`);
  console.log(`   POST /api/subscription/portal`);
  console.log(`   POST /api/subscription/cancel`);
  console.log(`   POST /api/subscription/reactivate`);
  console.log(`   POST /api/subscription/change-plan`);
});