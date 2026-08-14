# LinkedIn Guide

Complete guide for LinkedIn operations via xAPI — person profiles with career history, company pages, posts and comments, and job search.

> **Dynamic catalog:** These are database-registered third-party APIs under the `linkedin` service. Exact action IDs, HTTP methods, parameters, response fields, charging, and retry behavior can change. Run `search` and `get` before calling; the current schema and live response win. Examples below reflect the `linkedin_web v2` version and keep `"method":"GET"` in the input for compatibility.

## Contents

- [Key concept: everything is addressed by URL](#key-concept-everything-is-addressed-by-url)
- [Person data](#person-data)
  - [When `experience` and `education` come back `null`](#when-experience-and-education-come-back-null)
- [Company data](#company-data)
- [Posts and comments](#posts-and-comments)
- [Jobs](#jobs)
- [Common workflows](#common-workflows)
- [Pagination](#pagination)
- [API reference](#api-reference)
- [Error handling](#error-handling)

## Key Concept: everything is addressed by URL

Every `linkedin_web v2` endpoint except job search is addressed by an ordinary public LinkedIn page URL passed as `url`. There is no separate ID-resolution step: paste the URL you would open in a browser. The one extra parameter is `urn` on [post comments](#get-comments-on-a-post), and it is derived from the post URL.

| Resource | URL shape |
|----------|-----------|
| Person | `https://www.linkedin.com/in/<vanity>/` |
| Company | `https://www.linkedin.com/company/<slug>/` |
| Post | `https://www.linkedin.com/feed/update/urn:li:activity:<id>/` or `https://www.linkedin.com/posts/<slug>-activity-<id>-<hash>` |
| Job | `https://www.linkedin.com/jobs/view/<job_id>` |

Discover the current endpoint set before relying on any list here:

```bash
npx xapi-to search "linkedin" --source api
npx xapi-to get linkedin.api_v1_linkedin_web__v2_get__user__profile
```

## Person Data

### Get a profile

```bash
npx xapi-to call linkedin.api_v1_linkedin_web__v2_get__user__profile \
  --input '{"method":"GET","params":{"url":"https://www.linkedin.com/in/williamhgates/"}}'
```

One call returns the whole profile — no follow-up requests for individual sections. `data.data` contains:

- Identity: `name`, `first_name`, `last_name`, `id` (vanity), `linkedin_id`, `linkedin_num_id`, `url`, `avatar`, `banner_image`, `influencer`
- Headline & summary: `position`, `about`, `unformatted_about`, `bio_links`
- Location: `city`, `location`, `country_code`
- Career: `experience[]`, `current_company`, `current_company_name`, `current_company_company_id`
- Education: `education[]`, `educations_details`
- Recognition: `honors_and_awards[]`
- Social proof: `followers`, `connections`, `activity[]`, `posts[]`
- Discovery: `people_also_viewed[]`, `similar_profiles[]`

There are no separate `get__user__experience` / `educations` / `skills` / `honors` / `publications` endpoints in v2 — that was the older `username` → `urn` two-step API. If you were using those IDs, they now return `Action not found`.

### When `experience` and `education` come back `null`

`get__user__profile` reads the **logged-out** public page. LinkedIn renders the full career and school sections there only for creator/open profiles; on an ordinary member's page it serves a trimmed topcard. The call still succeeds with `code: 200`, so the failure is silent — you get identity, `current_company`, `educations_details`, `followers`, and `people_also_viewed`, but:

```json
{ "position": null, "experience": null, "education": null, "about": "Don't use LinkedIn that much…" }
```

`null` here means **not rendered to logged-out visitors**, not "this person has no jobs listed". A truncated `about` ending in `…` is the same signal. Never summarize a person's background from a response in this state, and never report the profile as private or empty — fall back:

```bash
npx xapi-to call icypeas-email.api_scrape_profile \
  --input '{"method":"GET","params":{"url":"https://www.linkedin.com/in/ricky-wang-74b3a0194/"}}'
```

This returns a differently-shaped payload under `data.result`:

| Field | Contents |
|---|---|
| `worksFor[]` | Current positions — `jobTitle`, `startDate`, `description`, nested `company` (industry, size, website, HQ) |
| `alumniOf[]` | Past positions — same shape plus `endDate` |
| `educations[]` | `name`, `degree`, `fieldsOfStudy[]`, `description` |
| `headline`, `description` | Headline and the full untruncated About text |
| `firstname`, `lastname`, `address`, `numOfConnections`, `skills[]`, `languages[]` | Identity and profile detail |

Check `data.status` before reading `data.result`: `FOUND` means real data, `NOT_FOUND` means `result` is `null` and this source has nothing for that URL either. Two caveats worth carrying into any summary: the snapshot is cached, so `headline` can lag the person's current role, and `startDate`/`endDate` are year-granular (often stamped to January), so treat them as approximate. `jobTitle` also reflects whatever the member typed, which can disagree with a company's own announcement — prefer cross-checking a role against `web.search` before asserting a title.

Do not reach for `contactout-api.v1_linkedin_enrich` as a fallback. Without a separate ContactOut contract it returns a fully-populated **sample profile** (`"Example Person"` at `"Legros, Smitham and Kessler"`) with `status_code: 200`, which is easy to mistake for real data, and it is the most expensive LinkedIn-adjacent action in the catalog.

### Person profile decision path

```
get__user__profile
  ├─ experience[] present            → done, use it
  └─ experience/education == null    → icypeas-email.api_scrape_profile
        ├─ status == FOUND           → read worksFor / alumniOf / educations
        └─ status == NOT_FOUND       → say the career history is unavailable;
                                        fall back to web.search for public
                                        bios, or twitter.user_by_screen_name
                                        when the person came from an X handle
```

### Get a person's posts

```bash
npx xapi-to call linkedin.api_v1_linkedin_web__v2_get__user__posts \
  --input '{"method":"GET","params":{"url":"https://www.linkedin.com/in/williamhgates/","page":1}}'
```

Returns `data.data.data[]` plus `data.data.paging`. Each item carries `urn`, `post_url`, `text`, `time`/`posted`, `poster`, `images[]`, and a reaction breakdown (`num_likes`, `num_comments`, `num_reposts`, `num_reactions`, `num_empathy`, `num_praises`, …).

Keep `urn` from here — it is the numeric activity ID that [post comments](#get-comments-on-a-post) additionally requires.

## Company Data

### Get a company page

```bash
npx xapi-to call linkedin.api_v1_linkedin_web__v2_get__company__profile \
  --input '{"method":"GET","params":{"url":"https://www.linkedin.com/company/anthropicresearch/"}}'
```

Returns `data.data` with `name`, `company_id`, `about`, `description`, `slogan`, `website`, `industries`, `company_size`, `organization_type`, `followers`, `employees_in_linkedin`, `employees[]`, `locations[]`, `logo`, `image`, `similar[]`, `affiliated[]`, `alumni` / `alumni_information`, `updates[]`.

### Get a company's posts

```bash
npx xapi-to call linkedin.api_v1_linkedin_web__v2_get__company__posts \
  --input '{"method":"GET","params":{"url":"https://www.linkedin.com/company/anthropicresearch/","page":1}}'
```

Same envelope as person posts: `data.data.data[]` + `data.data.paging`.

## Posts and Comments

### Get post detail

```bash
npx xapi-to call linkedin.api_v1_linkedin_web__v2_get__post__detail \
  --input '{"method":"GET","params":{"url":"https://www.linkedin.com/feed/update/urn:li:activity:7490874650621612032/"}}'
```

Returns the full post: `post_text`, `post_text_html`, `title`, `headline`, `date_posted`, `hashtags[]`, `embedded_links[]`, `images[]`, `videos[]`, `num_likes`, `num_comments`, `top_visible_comments[]`, `repost`, `tagged_people[]`, `tagged_companies[]`, `external_link_data`, plus author context (`user_name`, `user_title`, `user_followers`, `author_profile_pic`).

### Get comments on a post

**This endpoint requires two parameters, not one** — `url` *and* `urn`, the bare numeric activity ID. Both are marked required in the schema, and `urn` is pattern-validated as `^[0-9]+$`.

```bash
npx xapi-to call linkedin.api_v1_linkedin_web__v2_get__post__comments \
  --input '{"method":"GET","params":{"url":"https://www.linkedin.com/feed/update/urn:li:activity:7490874650621612032/","urn":"7490874650621612032","page":1}}'
```

Extract `urn` from the post URL — the digits after `activity:` (feed form) or after `-activity-` (posts form). Passing the prefixed `urn:li:activity:7490874650621612032` form is rejected by the pattern check before the call is billed.

Returns `data.data.data[]` with `text`, `commenter`, `created_at`, `created_datetime`, `permalink`, `pinned`, `replies`, `thread_urn`, plus `data.data.total` and `data.data.pagination_token`.

## Jobs

### Search jobs

The one endpoint that is not URL-addressed:

```bash
npx xapi-to call linkedin.api_v1_linkedin_web__v2_search__jobs \
  --input '{"method":"GET","params":{"keywords":"machine learning engineer","location":"United States","page":1}}'
```

`keywords` is required; `location` and `page` are optional. Returns `data.data.data[]` (`job_title`, `job_url`, `job_urn`, `company`, `company_linkedin_url`, `company_logo`, `location`, `remote`, `salary`, `posted_time`) plus `data.data.total`.

### Get job detail

```bash
npx xapi-to call linkedin.api_v1_linkedin_web__v2_get__job__detail \
  --input '{"method":"GET","params":{"url":"https://www.linkedin.com/jobs/view/4442605025"}}'
```

Returns `data.data.data` with the full JD (`job_description`), `job_title`, `job_type`, `experience_level`, `job_functions[]`, `skills[]`, `salary_details`, `salary_display`, `benefits[]`, `remote_allow`, `applies`, `views`, `posted`, `closed`/`expired`, `hiring_team[]`, and company context (`company_name`, `company_id`, `company_description`, `employee_count`, `industries[]`, `hq_*` address fields).

This is the most expensive LinkedIn endpoint — search first, then fetch detail only for the postings you actually care about.

## Common Workflows

### Profile → recent activity

```bash
# 1. Whole profile in one call
npx xapi-to call linkedin.api_v1_linkedin_web__v2_get__user__profile \
  --input '{"method":"GET","params":{"url":"https://www.linkedin.com/in/williamhgates/"}}'

# 1b. Only if experience/education came back null — career history from the fallback
npx xapi-to call icypeas-email.api_scrape_profile \
  --input '{"method":"GET","params":{"url":"https://www.linkedin.com/in/williamhgates/"}}'

# 2. Their posts (take `urn` from each item for step 3)
npx xapi-to call linkedin.api_v1_linkedin_web__v2_get__user__posts \
  --input '{"method":"GET","params":{"url":"https://www.linkedin.com/in/williamhgates/","page":1}}'

# 3. Comments on one post — url AND numeric urn
npx xapi-to call linkedin.api_v1_linkedin_web__v2_get__post__comments \
  --input '{"method":"GET","params":{"url":"<post_url>","urn":"<urn>","page":1}}'
```

### Job hunt

```bash
# 1. Search (cheap, paginated)
npx xapi-to call linkedin.api_v1_linkedin_web__v2_search__jobs \
  --input '{"method":"GET","params":{"keywords":"rust engineer","location":"Berlin","page":1}}'

# 2. Detail only for shortlisted job_url values
npx xapi-to call linkedin.api_v1_linkedin_web__v2_get__job__detail \
  --input '{"method":"GET","params":{"url":"<job_url>"}}'

# 3. Company context
npx xapi-to call linkedin.api_v1_linkedin_web__v2_get__company__profile \
  --input '{"method":"GET","params":{"url":"<company_linkedin_url>"}}'
```

## Pagination

`get__user__posts`, `get__company__posts`, `get__post__comments`, and `search__jobs` take a 1-based `page` integer. Posts responses carry `data.data.paging`; comments carry `total` and `pagination_token`; job search carries `total`. Increment `page` until a response comes back exhausted — note that past the last page the upstream returns `code: 200` with `data: null` (not an empty array), so test for falsy rather than for `length === 0`. The other four endpoints return a complete resource and take no pagination parameter.

## API Reference

| Action ID (`linkedin.api_v1_linkedin_web__v2_…`) | Purpose | Required params | Optional |
|---|---|---|---|
| `get__user__profile` | Full person profile + experience/education/honors | `url` | — |
| `get__user__posts` | A person's posts | `url` | `page` |
| `get__company__profile` | Company page | `url` | — |
| `get__company__posts` | A company's posts | `url` | `page` |
| `get__post__detail` | Single post, full text and media | `url` | — |
| `get__post__comments` | Comments on a post | `url` **and** `urn` (digits only) | `page` |
| `search__jobs` | Job search | `keywords` | `location`, `page` |
| `get__job__detail` | Full job posting | `url` | — |

One non-`linkedin` action belongs in this workflow:

| Action ID | Purpose | Required params | Notes |
|---|---|---|---|
| `icypeas-email.api_scrape_profile` | Career history for profiles the logged-out page hides | `url` | Fallback when `get__user__profile` returns `experience: null`. Check `data.status == "FOUND"`. |

Detail-style endpoints (`get__*__profile`, `get__post__detail`) are the cheapest; list-style endpoints (posts, comments, job search) cost more per call, and `get__job__detail` is the most expensive. Run `npx xapi-to get <action-id>` for the current `meta.pricing` rather than assuming these ratios hold.

## Error Handling

- **`Action not found: linkedin.api_v1_linkedin_web_…`** — you used a pre-v2 action ID. The `username` → `urn` two-step endpoints (`get__user__experience`, `get__user__educations`, `get__user__skills`, `get__user__contact`, `search__people`, `get__company__jobs`, …) are gone; everything is now `…_linkedin_web__v2_…` and URL-addressed. Re-discover with `npx xapi-to search "linkedin" --source api`.
- **`Input validation failed … must have required property 'url'`** — the gateway rejected the call before it reached LinkedIn. Check the `params` object, not `pathParams`.
- **`must have required property 'urn'`** — `get__post__comments` needs the numeric `urn` alongside `url`. See [Get comments on a post](#get-comments-on-a-post).
- **`must match pattern "^[0-9]+$"` on `/params/urn`** — you passed the prefixed `urn:li:activity:<id>` form. Send the digits only.
- **`API Token lacks required permissions`** (upstream `403`) — the account's upstream provider token has no LinkedIn scope. This is an account entitlement, not a parameter problem; enable it in the provider dashboard.
- **`experience: null` / `education: null` / `about` ending in `…` on `get__user__profile`** — not an error and not a private profile: the logged-out page LinkedIn serves for ordinary members omits those sections. Fall back to `icypeas-email.api_scrape_profile`. See [When `experience` and `education` come back `null`](#when-experience-and-education-come-back-null).
- **A ContactOut response naming `Example Person` at `Legros, Smitham and Kessler`** — `contactout-api.*` returned its sample payload because the account has no ContactOut entitlement. It carries `status_code: 200` and a `message` pointing at a sales call. Discard it; never summarize from it.
- **Empty `data[]` on a valid URL** — either the page is private/deleted, or you paginated past the end. LinkedIn also rate-limits aggressively; retry with backoff rather than in a tight loop.
