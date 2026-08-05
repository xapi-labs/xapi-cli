# SMS Verification Guide

Use xAPI's 5SIM SMS service to get virtual phone numbers and receive SMS verification codes for platform registrations (Claude, OpenAI, Telegram, etc.).

> **Dynamic catalog:** These are database-registered third-party APIs, not built-in capabilities. Exact action IDs, HTTP methods, parameters, billing rules, and response fields can change. Run `search` and then `get` before every paid workflow; the current schema, service terms, quoted price, and live response are authoritative. Examples below reflect one known GET-based version.

Use virtual numbers only where the target service permits them. Do not use this workflow to bypass access controls, identity checks, account limits, or platform terms.

## Contents

- [How it works](#how-it-works)
- [Check availability](#step-1-check-availability)
- [Buy a number](#step-2-buy-a-number)
- [Use the number](#step-3-use-the-number)
- [Check for SMS](#step-4-check-for-sms)
- [Finish or cancel](#step-5-finish-or-cancel)
- [Agent workflow](#complete-agent-workflow)
- [API reference](#api-reference)
- [Error handling](#error-handling)

## How It Works

1. **Check availability** — See stock and pricing by country
2. **Buy a number** — Review the live quote and obtain explicit user confirmation before this paid action
3. **Use the number** — Enter it on the target platform's registration page
4. **Check for SMS** — Poll until the verification code arrives
5. **Finish or cancel** — Confirm completion, or cancel/ban if the number didn't work

**Billing:** Treat purchase, finish, cancel, ban, settlement, and refund behavior as service-version dependent. Some versions may reserve balance first and settle later; others may charge at purchase. Never promise a refund or a final charge point without checking the current schema and service terms.

## Step 1: Check Availability

```bash
npx xapi-to call 5sim-sms.v1_guest_products_country_operator_product \
  --method GET \
  --input '{"pathParams":{"country":"any","operator":"any","product":"claudeai"},"params":{"single":0,"sort":"top"}}'
```

Returns stock and pricing per country. Pick a country with good stock and low price.

### Common Product Names

| Platform | Product name |
|----------|-------------|
| Claude / Anthropic | `claudeai` |
| OpenAI / ChatGPT | `openai` |
| Telegram | `telegram` |
| WhatsApp | `whatsapp` |
| Google | `google` |
| Discord | `discord` |
| Twitter / X | `twitter` |

Treat these names as examples, not a stable catalog. Use `npx xapi-to search "5sim <platform>" --source api`, inspect candidates with `get`, or query the current products endpoint.

As a last resort, you can list all products:

```bash
npx xapi-to call 5sim-sms.v1_guest_products_country_operator \
  --method GET \
  --input '{"pathParams":{"country":"any","operator":"any"}}'
```

The full product response can be large; filter it locally or query a product-specific endpoint after discovering the current name.

## Step 2: Buy a Number

```bash
npx xapi-to call 5sim-sms.v1_user_buy_activation_country_operator_product \
  --method GET \
  --input '{"pathParams":{"country":"england","operator":"any","product":"claudeai"}}'
```

Response:

```json
{
  "id": 123456789,
  "phone": "+447123456789",
  "operator": "three",
  "product": "claudeai",
  "price": 0.05,
  "status": "PENDING",
  "country": "england"
}
```

Before running the buy call, show the user the selected country, operator, product, quoted price, and applicable cancellation/refund terms, then obtain explicit confirmation. **Save the returned `id` and `phone`**; the `id` is needed for subsequent operations.

Inspect the returned balance/order fields to determine whether the current version reserved or charged funds. Do not infer settlement solely from a successful HTTP response.

## Step 3: Use the Number

Tell the user to:

1. Go to the target platform's sign-up page (e.g. claude.ai)
2. Enter the phone number from step 2 (e.g. `+447123456789`)
3. Click "Send verification code"

**This step requires human action.** Wait for the user to confirm they've requested the code.

## Step 4: Check for SMS

```bash
npx xapi-to call 5sim-sms.v1_user_check_id \
  --method GET \
  --input '{"pathParams":{"id":"123456789"}}'
```

Response when SMS received:

```json
{
  "id": 123456789,
  "phone": "+447123456789",
  "status": "RECEIVED",
  "sms": [
    {
      "created_at": "2026-03-26T10:30:00Z",
      "text": "Your Claude verification code is: 834291",
      "code": "834291"
    }
  ]
}
```

If `status` is still `PENDING`, wait a few seconds and poll again until the order's current expiry or retry limit.

**Polling strategy:** Start around every 5 seconds, respect any upstream retry guidance, and stop at the order's current expiry. Do not create another paid order without a new confirmation.

## Step 5: Finish or Cancel

### Finish (mark order as completed)

After the user has successfully used the verification code:

```bash
npx xapi-to call 5sim-sms.v1_user_finish_id \
  --method GET \
  --input '{"pathParams":{"id":"123456789"}}'
```

### Cancel

If the SMS never arrives or the number doesn't work:

```bash
npx xapi-to call 5sim-sms.v1_user_cancel_id \
  --method GET \
  --input '{"pathParams":{"id":"123456789"}}'
```

Read the returned order and balance fields to determine the result. Cancellation does not imply that a refund is either guaranteed or impossible.


## Complete Agent Workflow

When a user asks to register for a platform using SMS verification:

1. Ask which platform (to determine the product name)
2. Check availability and pricing — suggest the cheapest option with good stock
3. Show the exact quote and terms, obtain explicit confirmation, then buy one number
4. Tell the user to enter the number on the platform and request the code
5. Poll for SMS — check every 5 seconds until received
6. Show the verification code to the user
7. Wait for user to confirm they've completed registration
8. Call finish to confirm, or cancel if something went wrong

## API Reference

| API | Description |
|-----------|-------------|
| `5sim-sms.v1_guest_products_country_operator_product` | Check stock and pricing by country/product |
| `5sim-sms.v1_guest_products_country_operator` | List all available products |
| `5sim-sms.v1_guest_countries` | List all supported countries |
| `5sim-sms.v1_guest_prices` | Query prices by country/product/carrier |
| `5sim-sms.v1_user_buy_activation_country_operator_product` | Buy a number; inspect the response for billing state |
| `5sim-sms.v1_user_check_id` | Check order status and SMS content |
| `5sim-sms.v1_user_finish_id` | Confirm completion under current service terms |
| `5sim-sms.v1_user_cancel_id` | Request cancellation under current service terms |

## Error Handling

- **"Bad product"** → Rediscover the current action/product with `search`, `get`, or the products endpoint; do not keep guessing paid inputs.
- **SMS never arrives** → Inspect the order's allowed cancel/ban actions and terms. Ask before buying another number in a different country.
- **Insufficient balance** → Top up: `npx xapi-to topup --method stripe --amount 10`
- **Number rejected by platform** → Some platforms block certain countries. Try USA or UK numbers.
