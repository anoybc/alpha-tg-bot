// ⚡ ALPHA Worker — Checkout Type Detector
// Mirrors the detection logic from the extension's content.js

export async function detectCheckoutType(page) {
  const url = page.url().toLowerCase();

  // ── Hosted / SaaS checkout pages ──────────────────────────────────────────
  if (url.includes('checkout.stripe.com'))            return 'stripe-hosted';
  if (url.includes('js.stripe.com'))                  return 'stripe-js';
  if (url.match(/shopify\.com.*\/checkouts?/))        return 'shopify';
  if (url.includes('squareup.com'))                   return 'square';
  if (url.includes('pay.google.com'))                 return 'google-pay';
  if (url.includes('paypal.com'))                     return 'paypal';

  // ── Page-content fingerprinting ───────────────────────────────────────────
  try {
    // Stripe Elements (embedded iframes inside merchant page)
    const hasStripeIframe = await page.$('iframe[name*="stripe"], iframe[src*="stripe.com/elements"], iframe[src*="js.stripe.com"]');
    if (hasStripeIframe) return 'stripe-elements-iframe';

    // Stripe Elements (direct injection — no iframe)
    const hasStripeEl = await page.$('[data-elements-stable-field-name]');
    if (hasStripeEl) return 'stripe-elements-direct';

    // WooCommerce
    const hasWoo = await page.$('#woocommerce-checkout-nonce, .woocommerce-checkout, #payment.woocommerce-checkout-payment');
    if (hasWoo) return 'woocommerce';

    // Shopify (self-hosted storefront)
    const hasShopify = await page.$('[data-shopify], .shopify-payment-button, #checkout');
    if (hasShopify) return 'shopify';

    // Braintree
    const hasBraintree = await page.$('iframe[id*="braintree"], [data-braintree-id]');
    if (hasBraintree) return 'braintree';
  } catch {}

  return 'generic';
}
