# LinkedIn Guide

Complete guide for LinkedIn operations via xAPI — person profiles and full career history (experience, education, skills, honors, publications), company pages, and job search.

> **Dynamic catalog:** These are database-registered third-party APIs under the `linkedin` service. Exact action IDs, HTTP methods, parameters, response fields, charging, and retry behavior can change. Run `search` and `get` before calling; the current schema and live response win. Examples below reflect one known GET-based version and keep `"method":"GET"` in the input for compatibility.

## Contents

- [Identifiers](#key-concept-three-identifiers)
- [Person data](#person-data)
- [Company data](#company-data)
- [Jobs](#jobs)
- [Common workflows](#common-workflows)
- [Pagination](#pagination)
- [API reference](#api-reference)
- [Error handling](#error-handling)

## Key Concept: three identifiers

LinkedIn endpoints address people and companies by three different keys. Picking the wrong one is the #1 cause of `400` errors.

| Identifier | Looks like | Where it comes from | Used by |
|---|---|---|---|
| `username` | `williamhgates` (vanity slug from `linkedin.com/in/<username>`) | You already have it, or find it via `search_people` | `get_user_profile`, `get_user_contact`, `get_user_follower_and_connection` |
| `urn` | `ACoAAA8BYqEBCGLg_vT_ca6mMEqkpp9nVffJ3hc` | The `urn` field returned by `get_user_profile` | **Almost every** person detail endpoint (experience, educations, skills, honors, posts, …) |
| `company_id` | `74126343` (numeric) | The `id` field returned by `get_company_profile` | `get_company_people`, `get_company_posts`, `get_company_jobs`, `get_company_job_count` |

**The standard person workflow is two steps:** call `get_user_profile` with a `username` to obtain the `urn`, then pass that `urn` to the detail endpoints.

```bash
# Step 1 — profile + urn by vanity username
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__profile \
  --input '{"method":"GET","params":{"username":"williamhgates"}}'
# → data.data.urn = "ACoAAA8BYqEB..."

# Step 2 — use the urn for any detail section
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__experience \
  --input '{"method":"GET","params":{"urn":"ACoAAA8BYqEB..."}}'
```

> ⚠️ **Percent-encode non-ASCII usernames.** A slug like `levent-alpöge-b6426319` must be sent as `levent-alp%C3%B6ge-b6426319` (raw `ö` returns `400`).
>
> The upstream can return `HTTP 400` with `"message": "Request failed. Please retry."`. Treat this as an upstream failure, use bounded exponential backoff, and inspect the current usage/balance response before making any charging claim. Repeated failures can have several causes; do not label them as rate limiting unless the live response says so.

## Person Data

### Get a user profile (start here)

```bash
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__profile \
  --input '{"method":"GET","params":{"username":"williamhgates"}}'
```

Returns `data.data` with: `id`, `urn`, `public_identifier`, `first_name`, `last_name`, `full_name`, `headline`, `location`, `is_premium`, `is_influencer`, `is_creator`, `is_top_voice`, `birth`, `created_date`, `website`.

**Fold sub-sections into one call** with `include_*` flags (each adds `+1` upstream request, so more chances to hit the flaky `400` — prefer the dedicated `urn` endpoints below when reliability matters):

```bash
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__profile \
  --input '{"method":"GET","params":{"username":"williamhgates","include_experiences":true,"include_educations":true,"include_skills":true,"include_honors":true}}'
```

Available flags: `include_bio`, `include_honors`, `include_skills`, `include_interests`, `include_educations`, `include_volunteers`, `include_experiences`, `include_publications`, `include_certifications`, `include_follower_and_connection`.

### Get work experience

```bash
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__experience \
  --input '{"method":"GET","params":{"urn":"ACoAAA8BYqEB..."}}'
```

Returns `data.data` with `total`, `has_more`, `page`, and `data[]` — each item has `title`, `description`, `date` (`start`/`end`), and `company` (`id`, `name`, `url`, `logo`). Optional: `page`.

### Get education

```bash
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__educations \
  --input '{"method":"GET","params":{"urn":"ACoAAA8BYqEB..."}}'
```

Each item has `school`, `degree`, `date` (`start`/`end`), `description`. Optional: `page`.

### Get skills / certifications / honors / publications

All four take the same shape (`urn`, optional `page`):

```bash
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__skills          --input '{"method":"GET","params":{"urn":"ACoAAA8BYqEB..."}}'
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__certifications  --input '{"method":"GET","params":{"urn":"ACoAAA8BYqEB..."}}'
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__honors          --input '{"method":"GET","params":{"urn":"ACoAAA8BYqEB..."}}'
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__publications    --input '{"method":"GET","params":{"urn":"ACoAAA8BYqEB..."}}'
```

### Get recommendations

```bash
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__recommendations \
  --input '{"method":"GET","params":{"urn":"ACoAAA8BYqEB...","type":"received"}}'
```

Optional: `page`, `type` (`received` / `given`), `pagination_token`.

### Get interests (companies / groups)

```bash
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__interests__companies --input '{"method":"GET","params":{"urn":"ACoAAA8BYqEB..."}}'
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__interests__groups    --input '{"method":"GET","params":{"urn":"ACoAAA8BYqEB..."}}'
```

Optional: `page`.

### Get about / contact / follower & connection counts

```bash
# "About" section (join date, contact-info freshness) — takes urn
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__about --input '{"method":"GET","params":{"urn":"ACoAAA8BYqEB..."}}'

# Public contact info — takes username
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__contact --input '{"method":"GET","params":{"username":"williamhgates"}}'

# Follower & connection counts — takes username
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__follower__and__connection --input '{"method":"GET","params":{"username":"williamhgates"}}'
```

> Note the mix: `get_user_about` takes **`urn`**, while `get_user_contact` and `get_user_follower_and_connection` take **`username`**.

### Get a user's activity (posts / comments / images / videos)

All four take `urn`, optional `page` and `pagination_token`:

```bash
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__posts    --input '{"method":"GET","params":{"urn":"ACoAAA8BYqEB..."}}'
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__comments --input '{"method":"GET","params":{"urn":"ACoAAA8BYqEB..."}}'
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__images   --input '{"method":"GET","params":{"urn":"ACoAAA8BYqEB..."}}'
npx xapi-to call linkedin.api_v1_linkedin_web_get__user__videos   --input '{"method":"GET","params":{"urn":"ACoAAA8BYqEB..."}}'
```

### Search people

```bash
npx xapi-to call linkedin.api_v1_linkedin_web_search__people \
  --input '{"method":"GET","params":{"name":"Levent Alpöge","company":"Anthropic"}}'
```

All parameters are optional (pass at least one): `name`, `first_name`, `last_name`, `title`, `company`, `current_company` (company ID), `school`, `industry` (industry ID), `geocode_location` (e.g. `103644278` for United States), `profile_language`, `service_category`, `page`. Use this to resolve a person to their `username`/`urn` when you only have a name.

## Company Data

### Get company profile (start here for companies)

```bash
# By vanity slug from linkedin.com/company/<company>
npx xapi-to call linkedin.api_v1_linkedin_web_get__company__profile \
  --input '{"method":"GET","params":{"company":"anthropicresearch"}}'

# Or by numeric company_id
npx xapi-to call linkedin.api_v1_linkedin_web_get__company__profile \
  --input '{"method":"GET","params":{"company_id":"74126343"}}'
```

Returns the company `id` (the `company_id` the endpoints below require), name, description, industry, size, headquarters, follower count, logo.

### Get company people / posts / job count

```bash
npx xapi-to call linkedin.api_v1_linkedin_web_get__company__people    --input '{"method":"GET","params":{"company_id":"74126343"}}'
npx xapi-to call linkedin.api_v1_linkedin_web_get__company__posts     --input '{"method":"GET","params":{"company_id":"74126343","sort_by":"recent"}}'
npx xapi-to call linkedin.api_v1_linkedin_web_get__company__job__count --input '{"method":"GET","params":{"company_id":"74126343"}}'
```

Optional: `page` (people/posts), `sort_by` (posts).

### Get company jobs

```bash
npx xapi-to call linkedin.api_v1_linkedin_web_get__company__jobs \
  --input '{"method":"GET","params":{"company_id":"74126343","remote":"remote","date_posted":"past_week"}}'
```

Optional filters: `page`, `remote`, `sort_by`, `job_type`, `easy_apply`, `date_posted`, `experience_level`, `under_10_applicants`, `fair_chance_employer`.

## Jobs

### Search jobs

```bash
npx xapi-to call linkedin.api_v1_linkedin_web_search__jobs \
  --input '{"method":"GET","params":{"keyword":"machine learning engineer","geocode":"103644278","remote":"remote"}}'
```

`keyword` is required. Optional filters: `page`, `remote`, `company`, `geocode`, `sort_by`, `job_type`, `easy_apply`, `date_posted`, `experience_level`, `has_verifications`, `under_10_applicants`, `fair_chance_employer`.

### Get job detail

```bash
npx xapi-to call linkedin.api_v1_linkedin_web_get__job__detail \
  --input '{"method":"GET","params":{"job_id":"4012345678","include_skills":"true"}}'
```

`job_id` is required (from a search result). Optional: `include_skills`.

## Common Workflows

### Investigate a person (full dossier)

1. Resolve to profile: `get_user_profile` with `username` → `urn`, headline, location
2. Career: `get_user_experience` + `get_user_educations` with the `urn`
3. Credentials: `get_user_skills`, `get_user_honors`, `get_user_publications`, `get_user_certifications`
4. Reach: `get_user_follower_and_connection` with `username`
5. Recent activity: `get_user_posts` / `get_user_comments` with the `urn`

### Find someone by name, then dig in

1. `search_people` with `name` (+ `company`/`title` to disambiguate) → `username`/`urn`
2. Follow the dossier workflow above

### Research a company and its openings

1. `get_company_profile` with the `company` slug → `company_id`, size, followers
2. `get_company_job_count` → how many openings
3. `get_company_jobs` with filters → the actual listings
4. `get_job_detail` with a `job_id` → full description + required skills

## Pagination

Person detail and activity endpoints return `page`, `total`, and `has_more`. Paginate by incrementing `page` (and passing `pagination_token` where the endpoint accepts it) until `has_more` is `false`.

## API Reference

| API (prefix: `linkedin.api_v1_linkedin_web_`) | Description | Key Params |
|---|---|---|
| `get__user__profile` | Person profile (returns `urn`) | `username`*, `include_*` |
| `get__user__about` | About / join date | `urn`* |
| `get__user__experience` | Work experience | `urn`*, `page` |
| `get__user__educations` | Education | `urn`*, `page` |
| `get__user__skills` | Skills | `urn`*, `page` |
| `get__user__certifications` | Certifications | `urn`*, `page` |
| `get__user__honors` | Honors & awards | `urn`*, `page` |
| `get__user__publications` | Publications | `urn`*, `page` |
| `get__user__recommendations` | Recommendations | `urn`*, `type`, `page` |
| `get__user__interests__companies` | Followed companies | `urn`*, `page` |
| `get__user__interests__groups` | Groups | `urn`*, `page` |
| `get__user__follower__and__connection` | Follower/connection counts | `username`* |
| `get__user__contact` | Public contact info | `username`* |
| `get__user__posts` | User's posts | `urn`*, `page`, `pagination_token` |
| `get__user__comments` | User's comments | `urn`*, `page`, `pagination_token` |
| `get__user__images` | User's image posts | `urn`*, `page`, `pagination_token` |
| `get__user__videos` | User's video posts | `urn`*, `page`, `pagination_token` |
| `search__people` | Search people | `name`, `company`, `title`, `school`, … (all optional) |
| `get__company__profile` | Company profile (returns `company_id`) | `company` or `company_id` |
| `get__company__people` | Company employees | `company_id`*, `page` |
| `get__company__posts` | Company posts | `company_id`*, `sort_by`, `page` |
| `get__company__jobs` | Company job listings | `company_id`*, `remote`, `date_posted`, … |
| `get__company__job__count` | Company open-role count | `company_id`* |
| `search__jobs` | Search jobs | `keyword`*, `geocode`, `remote`, … |
| `get__job__detail` | Job detail | `job_id`*, `include_skills` |

\* = required

## Error Handling

- **`400` with `"Please retry"`** → Retry with bounded exponential backoff. Check live usage/balance separately; the error text alone does not prove charging or rate-limit state.
- **`400 must have required property 'urn'`** → You passed `username` to a `urn`-based endpoint. Call `get_user_profile` first, take `data.data.urn`, and retry.
- **`400` on a name with accents** → Percent-encode non-ASCII characters in the `username` slug (e.g. `ö` → `%C3%B6`).
- **Empty `data[]`** → The person hasn't filled in that section, or LinkedIn returns it empty; not an error.
- **Company endpoints reject a slug** → `get_company_people/posts/jobs` need the numeric `company_id`; resolve it via `get_company_profile` first.
