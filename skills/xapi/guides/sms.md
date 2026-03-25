# SMS Verification Guide

Use xAPI's 5SIM SMS service to get virtual phone numbers and receive SMS verification codes for platform registrations (Claude, OpenAI, Telegram, etc.).

## How It Works

1. **Check availability** — See stock and pricing by country
2. **Buy a number** — You are charged at this point
3. **Use the number** — Enter it on the target platform's registration page
4. **Check for SMS** — Poll until the verification code arrives
5. **Finish or cancel** — Confirm completion, or cancel/ban if the number didn't work

**Billing:** You are charged when you buy a number. There are no refunds for cancel or ban — the charge is final once a number is purchased.

## Step 1: Check Availability

```bash
npx xapi-to call 5sim-sms.v1_guest_products_country_operator_product \
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

To find a product name not listed above, try guessing common names (lowercase, no spaces) like `discord`, `instagram`, `linkedin`, etc. by calling `v1_guest_products_country_operator_product` directly.

As a last resort, you can list all products:

```bash
npx xapi-to call 5sim-sms.v1_guest_products_country_operator \
  --input '{"pathParams":{"country":"any","operator":"any"}}'
```

> **Warning:** This returns hundreds of products. The output is very large. Prefer guessing the product name first.

## Step 2: Buy a Number

```bash
npx xapi-to call 5sim-sms.v1_user_buy_activation_country_operator_product \
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

**Save the `id` and `phone`.** The `id` is needed for all subsequent operations.

**You are charged at this point.** The cost is deducted from your balance when the number is purchased.

## Step 3: Use the Number

Tell the user to:

1. Go to the target platform's sign-up page (e.g. claude.ai)
2. Enter the phone number from step 2 (e.g. `+447123456789`)
3. Click "Send verification code"

**This step requires human action.** Wait for the user to confirm they've requested the code.

## Step 4: Check for SMS

```bash
npx xapi-to call 5sim-sms.v1_user_check_id \
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

If `status` is still `PENDING`, wait a few seconds and poll again. Typical wait is 10-60 seconds.

**Polling strategy:** Check every 5 seconds, up to 2 minutes. If no SMS arrives, suggest trying a different country.

## Step 5: Finish or Cancel

### Finish (mark order as completed)

After the user has successfully used the verification code:

```bash
npx xapi-to call 5sim-sms.v1_user_finish_id \
  --input '{"pathParams":{"id":"123456789"}}'
```

### Cancel (mark order as cancelled — no refund)

If the SMS never arrives or the number doesn't work:

```bash
npx xapi-to call 5sim-sms.v1_user_cancel_id \
  --input '{"pathParams":{"id":"123456789"}}'
```

**No refund.** The charge is final. This just closes the order.


## Complete Agent Workflow

When a user asks to register for a platform using SMS verification:

1. Ask which platform (to determine the product name)
2. Check availability and pricing — suggest the cheapest option with good stock
3. Buy a number — show the phone number to the user
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
| `5sim-sms.v1_user_buy_activation_country_operator_product` | Buy a number (reserve balance) |
| `5sim-sms.v1_user_check_id` | Check order status and SMS content |
| `5sim-sms.v1_user_finish_id` | Confirm completion (charge now) |
| `5sim-sms.v1_user_cancel_id` | Cancel order (no refund) |

## Error Handling

- **"Bad product"** → Wrong product name. Try guessing (lowercase, no spaces). Avoid listing all products — the response is 84KB with 1373 items.
- **SMS never arrives** → Cancel and try a different country. Higher-priced numbers tend to work better.
- **Insufficient balance** → Top up: `npx xapi-to topup --method stripe --amount 10`
- **Number rejected by platform** → Some platforms block certain countries. Try USA or UK numbers.
