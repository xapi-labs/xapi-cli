# Changelog

## [0.3.2](https://github.com/xapi-labs/xapi-cli/compare/v0.3.1...v0.3.2) (2026-11-19)


### Features

* **call:** save complete JSON responses to private files ([a009785](https://github.com/xapi-labs/xapi-cli/commit/a009785e5944d1b63ae461e6b2e35a8eb96b190b))
* **cli:** improve service discovery and execution workflows ([#73](https://github.com/xapi-labs/xapi-cli/issues/73)) ([7b08dc0](https://github.com/xapi-labs/xapi-cli/commit/7b08dc0f6c8bbe9bfbde77cda438031c98e2100f))
* **cli:** improve service discovery, call output, and provider onboarding ([7b08dc0](https://github.com/xapi-labs/xapi-cli/commit/7b08dc0f6c8bbe9bfbde77cda438031c98e2100f))
* **cli:** promote execution envelopes to staging ([a265814](https://github.com/xapi-labs/xapi-cli/commit/a265814bf7d60145833675f3d0f8a72703abb76a))
* **cli:** show service, price and 30-day stats in action tables ([786041b](https://github.com/xapi-labs/xapi-cli/commit/786041bfc4dfaf778cc5aac18a6bc935799d1700))
* **cli:** validate discovery and provider onboarding in staging ([7bf9d2f](https://github.com/xapi-labs/xapi-cli/commit/7bf9d2faf0cc3b1850cb9145a3bfde5315adaf65))
* **provider:** import YAML with explicit default pricing ([194601d](https://github.com/xapi-labs/xapi-cli/commit/194601de767d44fdb4db926393e892da432b66d9))
* **provider:** show a service's review and lifecycle timeline ([810f89a](https://github.com/xapi-labs/xapi-cli/commit/810f89aec0eaa37e9c8df28511340c8166b523db))
* **sandbox:** server-side lifetime and spending caps, concise run output ([a00ed05](https://github.com/xapi-labs/xapi-cli/commit/a00ed054e0133a820dc09daea47cbc3b7a9f9f41))
* **sandbox:** show termination reasons and clarify budget limits ([6849d71](https://github.com/xapi-labs/xapi-cli/commit/6849d71394f2617c8752223bfbf507a64760db89))
* **skill:** explain import lifecycle and trusted discovery metadata ([960796c](https://github.com/xapi-labs/xapi-cli/commit/960796c68f65396ac72579e5144ab6b4e1e2f6e1))
* **skill:** guide service tags, official categories and token usage rules ([73696a4](https://github.com/xapi-labs/xapi-cli/commit/73696a4f7904d8fdc29535988093a43f1d20ab23))
* **skill:** guide Tripo async provider registration ([#61](https://github.com/xapi-labs/xapi-cli/issues/61)) ([550171c](https://github.com/xapi-labs/xapi-cli/commit/550171c4522d5d5a0d0ad0ce936d11e56d48dbef))
* **workers:** key-free local plan, secrets in init's next steps, shortest path in the skill ([33f20eb](https://github.com/xapi-labs/xapi-cli/commit/33f20eb0c1fc109ba3cc5282d7144050d301f6b1))


### Bug Fixes

* **agent:** report failed calls and protect generated chat routes ([a0b9d88](https://github.com/xapi-labs/xapi-cli/commit/a0b9d88897f2630ea015dd647612f258d1b3fa42))
* **call:** clarify uncertain failures and response evidence ([96ddd6a](https://github.com/xapi-labs/xapi-cli/commit/96ddd6accddc5890e938ba080ebd1ed444fe8aa6))
* **call:** preserve replaced files and complete JSON errors ([ac85a83](https://github.com/xapi-labs/xapi-cli/commit/ac85a83225321e28fc89b0f4d9915c30952380fa))
* **cli:** reuse the login session for balance and oauth ([af0a957](https://github.com/xapi-labs/xapi-cli/commit/af0a9571867c080ab747329bb3e1a3c5c075f129))
* **oauth:** inspect endpoint requirements before account binding ([fc59690](https://github.com/xapi-labs/xapi-cli/commit/fc596907dc8ab2c1e7900d177906b7d64c1fcbf2))
* **skill:** describe text search and provider tag compatibility ([4b72ccc](https://github.com/xapi-labs/xapi-cli/commit/4b72ccc446ea914ae5e76f1a7ace58eec28c2572))
* **skill:** explain referenced response schemas ([fbad100](https://github.com/xapi-labs/xapi-cli/commit/fbad100e7fe025eb86bca6f2da886d989c5dcc90))
* **skill:** handle Binance candle boundaries and USD volume ([#63](https://github.com/xapi-labs/xapi-cli/issues/63)) ([889c15e](https://github.com/xapi-labs/xapi-cli/commit/889c15ee0747757c57d6a6179ae27210c8222fca))
* **skill:** stop recommending the retired provider event feed ([#66](https://github.com/xapi-labs/xapi-cli/issues/66)) ([3a7c3d7](https://github.com/xapi-labs/xapi-cli/commit/3a7c3d7cd46348ed680c74451aa90231af2007bd))


### Documentation

* **action:** explain mixed billing states and overlapping amounts ([3d50300](https://github.com/xapi-labs/xapi-cli/commit/3d50300dddd3ce63d301093b1e4b17b8cbf3669c))
* **action:** name the separate raw cost-state headers ([bf86fa8](https://github.com/xapi-labs/xapi-cli/commit/bf86fa828ee7667268e3eed9b6a42ed0c0edca32))
* **cli:** keep the staging skill guide concise ([fe5c3c3](https://github.com/xapi-labs/xapi-cli/commit/fe5c3c32c155650f4de4516ee8fa5bdcee7b6dab))
* **provider:** explain readiness and interrupted review recovery ([24e0b71](https://github.com/xapi-labs/xapi-cli/commit/24e0b71db385da78ba4c2fead1b5f1e350b5a5be))
* **provider:** promote readiness and review guidance to staging ([1540b1b](https://github.com/xapi-labs/xapi-cli/commit/1540b1b9b063eeda0e9c3ee55866941c05791fc6))
* **skill:** describe the restored Twitter search fallback behavior ([ea4a49c](https://github.com/xapi-labs/xapi-cli/commit/ea4a49c9b5caa3b2170bf3862d1c762a7e095706))
* **skill:** how to choose between similar services and read a call's cost ([ef90979](https://github.com/xapi-labs/xapi-cli/commit/ef909791441c8bd354f04aa95063081fbbb48591))
* **skill:** tags and categories in search results ([80522c1](https://github.com/xapi-labs/xapi-cli/commit/80522c1ffc2c8faa880bb600949b2a5590207345))

## [0.3.1](https://github.com/xapi-labs/xapi-cli/compare/v0.3.0...v0.3.1) (2026-10-22)


### Features

* **provider:** upload local LOGO images when creating services ([#59](https://github.com/xapi-labs/xapi-cli/issues/59)) ([8801acc](https://github.com/xapi-labs/xapi-cli/commit/8801acc80fa59468c946af7edf2110b0a19f6154))


### Bug Fixes

* **deps:** prevent undici EventSource memory exhaustion ([3f1d089](https://github.com/xapi-labs/xapi-cli/commit/3f1d08965fd474d07a00eb68e1d568b4ba4efd43))

## [0.3.0](https://github.com/xapi-labs/xapi-cli/compare/v0.2.1...v0.3.0) (2026-10-16)


### ⚠ BREAKING CHANGES

* **workers:** remove manual pause and preserve deployment transport ([#51](https://github.com/xapi-labs/xapi-cli/issues/51))

  Migration: remove whole-project `workers retention pause` and `keep-paused` calls from scripts. System financial protection remains automatic; after funding, explicitly use `workers retention resume`. Schedule pause/resume and Queue consumer controls remain available outside financial retention. See the [lifecycle guide](skills/xapi-workers/references/lifecycle.md).

### Features

* **skill:** guide private D1 and R2 exports with CLI commands ([351a952](https://github.com/xapi-labs/xapi-cli/commit/351a9521d5e1e2aaef7f0b9477f8881eac9c65e5))


### Bug Fixes

* **cli:** correct Action discovery and bundled skill workflows ([#57](https://github.com/xapi-labs/xapi-cli/issues/57)) ([d257169](https://github.com/xapi-labs/xapi-cli/commit/d257169b5555bd2a0ebc94f004bda5dd7286262c))
  - Single Action schema queries preserve bare root IDs and endpoint UUIDs, and use batch lookup to avoid collection-route collisions. Missing IDs return an error; literal `/root` remains a distinct Action.
  - Bundled skills explain typed Decisions requests, model discovery and DYNAMIC settlement; HTTP/2 configuration and transport boundaries; and BlockPI/Aptos JSON and BCS workflows. These guides do not add gRPC support or native CLI BCS request uploads.
* **workers:** remove manual pause and preserve deployment transport ([#51](https://github.com/xapi-labs/xapi-cli/issues/51)) ([634ebc5](https://github.com/xapi-labs/xapi-cli/commit/634ebc5484422010f427b206798d42fb454d8674))
* **workers:** support native assets import and initial Secret setup ([db7faf7](https://github.com/xapi-labs/xapi-cli/commit/db7faf7d0b88c7c017f0c98b27c9a67524e736b3))

## [0.2.1](https://github.com/xapi-labs/xapi-cli/compare/v0.2.0...v0.2.1) (2026-10-10)


### Bug Fixes

* **cli:** respect polling delays when timers wake early ([03a98ea](https://github.com/xapi-labs/xapi-cli/commit/03a98eac7e365759b243c40d503dab5429d4e344))
* **workers:** preserve native deployment flows and simplify client controls ([#47](https://github.com/xapi-labs/xapi-cli/issues/47)) ([da62e96](https://github.com/xapi-labs/xapi-cli/commit/da62e963b6c8d158a08cd944c2b44b8b57451d9c))
* **workers:** recover uploads and preserve production settings and usage totals ([#48](https://github.com/xapi-labs/xapi-cli/issues/48)) ([c81669c](https://github.com/xapi-labs/xapi-cli/commit/c81669c47133d8969a21cd64ce449df8b01d9503))
* **workers:** report successful pushes to owner-paused environments ([#49](https://github.com/xapi-labs/xapi-cli/issues/49)) ([df39e56](https://github.com/xapi-labs/xapi-cli/commit/df39e566d9d428f240e420cd3004cf93a229c28b))

## [0.2.0](https://github.com/xapi-labs/xapi-cli/compare/v0.1.23...v0.2.0) (2026-09-29)


### ⚠ BREAKING CHANGES

* **workers:** workers push and workers promote no longer execute D1 SQL automatically. Run workers d1 migrations plan/apply --binding NAME --env ENV explicitly when schema changes are intended. Deployment nativeSteps now carries d1Migrations command guidance rather than SQL migration entries; imported D1 steps use EXPLICIT_COMMAND instead of BEFORE_CODE.

### Features

* **skill:** enable native Workers project deployment and setup ([#40](https://github.com/xapi-labs/xapi-cli/issues/40)) ([100024f](https://github.com/xapi-labs/xapi-cli/commit/100024f6cc76ca5a00bc6b9eccf0e87dfec3152b))
* **skill:** verify domain search suggestions before purchase ([#44](https://github.com/xapi-labs/xapi-cli/issues/44)) ([341d8dc](https://github.com/xapi-labs/xapi-cli/commit/341d8dcca2349ff501a0e2f0c9c3707265333bf6))


### Bug Fixes

* **skill:** guide Workers DNS conflicts and domain switching ([#41](https://github.com/xapi-labs/xapi-cli/issues/41)) ([eb3fd39](https://github.com/xapi-labs/xapi-cli/commit/eb3fd39c78891eb175c57b180228f79672789173))
* **workers:** continue pending R2 initialization before publishing ([36ddb9a](https://github.com/xapi-labs/xapi-cli/commit/36ddb9a004355fd18559e71c80976cc9a3893681))
* **workers:** resume pending R2 initialization during push ([8aa96dc](https://github.com/xapi-labs/xapi-cli/commit/8aa96dc3c107db2bdb52f1d461ba82549d9963bd))
* **workers:** retry R2 creation through the original push flow ([189874e](https://github.com/xapi-labs/xapi-cli/commit/189874efbf3b2336a70cf1fefa82b31b83b58b32))
* **workers:** separate D1 migrations from code deployment ([86ed3ba](https://github.com/xapi-labs/xapi-cli/commit/86ed3ba28a30a47f01b3a420ff5a6735492d5bc3))


### Documentation

* **skill:** document Workers domain conflict recovery ([#36](https://github.com/xapi-labs/xapi-cli/issues/36)) ([ac26d51](https://github.com/xapi-labs/xapi-cli/commit/ac26d51de6ab9a9e187a668b5d45182508c62228))

## [0.1.23](https://github.com/xapi-labs/xapi-cli/compare/v0.1.22...v0.1.23) (2026-09-21)


### Features

* **skill:** bundle CLI-native provider workflows ([#29](https://github.com/xapi-labs/xapi-cli/issues/29)) ([fe1551a](https://github.com/xapi-labs/xapi-cli/commit/fe1551a3b302cef584154b61f3c45da10267a353))
* **workers:** add managed project deployment workflows ([e002970](https://github.com/xapi-labs/xapi-cli/commit/e0029701152c9ad73277bef9e0750284e03c884d))
* **workers:** add read-only environment inspection ([f5e7245](https://github.com/xapi-labs/xapi-cli/commit/f5e7245e7bc8b01f62a1a9c2669ea1dbf9c48c9d))
* **workers:** add safe secret management workflows ([#32](https://github.com/xapi-labs/xapi-cli/issues/32)) ([0f0ec1b](https://github.com/xapi-labs/xapi-cli/commit/0f0ec1b498a012f35e6b5133fde2ec4c346c9ad6))
* **workers:** make deployment plans exact ([45aeac2](https://github.com/xapi-labs/xapi-cli/commit/45aeac24d2081b1496bc882fa27a313ab9f21250))
* **workers:** preserve native deployments and exact plans ([3b83be2](https://github.com/xapi-labs/xapi-cli/commit/3b83be2ac19061b53dbb1869a8a0061dbb5d9acf))


### Bug Fixes

* **workers:** clarify project deployment commands ([555dcb4](https://github.com/xapi-labs/xapi-cli/commit/555dcb4ff88d1633bf23d6709a56abb30f187104))
* **workers:** preserve native deployment intent during import ([74148a4](https://github.com/xapi-labs/xapi-cli/commit/74148a48351772a54457fca143d0eaa87f73db7b))

## [0.1.22](https://github.com/xapi-labs/xapi-cli/compare/v0.1.21...v0.1.22) (2026-09-17)


### Features

* **provider:** import API contracts and wait for publication ([#14](https://github.com/xapi-labs/xapi-cli/issues/14)) ([0b17d43](https://github.com/xapi-labs/xapi-cli/commit/0b17d43b5f24536f6a4b50d29de65a4045b81369))
* **provider:** manage per-user service rate limits ([49c974b](https://github.com/xapi-labs/xapi-cli/commit/49c974b82d42decb6fb55c7034f8cd562b2c9d03))
* **skill:** add domain and Web3 service guides ([86de0d1](https://github.com/xapi-labs/xapi-cli/commit/86de0d11f89a4a9d52fa1d407541150d71addefe))
* **skill:** document domains and GPT Live ([7466f4d](https://github.com/xapi-labs/xapi-cli/commit/7466f4db1ce8ea8172f85a4ce286e151aa0688c8))


### Bug Fixes

* **oauth:** enforce hard polling deadlines ([86e6828](https://github.com/xapi-labs/xapi-cli/commit/86e6828c411df85acbb6ad471951d38b31693590))
* **skill:** harden live service guidance ([137e8ab](https://github.com/xapi-labs/xapi-cli/commit/137e8ab7b32febe176e2f619d6c472655bbcb244))

## [0.1.21](https://github.com/xapi-labs/xapi-cli/compare/v0.1.20...v0.1.21) (2026-08-28)


### Bug Fixes

* **sandbox:** enforce hard wait deadlines during polling ([794ca16](https://github.com/xapi-labs/xapi-cli/commit/794ca16455e4bc6cbc1dccdec006652e5a16d437))
* **sandbox:** enforce hard wait deadlines during polling ([be18c7e](https://github.com/xapi-labs/xapi-cli/commit/be18c7e498697306974b6b973cfa38430db7fff7))

## [0.1.20](https://github.com/xapi-labs/xapi-cli/compare/v0.1.19...v0.1.20) (2026-08-25)


### Features

* **sandbox:** add managed sandbox CLI workflows ([bb31e74](https://github.com/xapi-labs/xapi-cli/commit/bb31e74e11a231f50ba2fdd56c4ed67bfcf98f88))
* **search:** --all-versions 开关（搜索含非默认但在跑的大版本） ([d8b2e9b](https://github.com/xapi-labs/xapi-cli/commit/d8b2e9b0f23c220244466792288a0d4982c80cd3))
* **skill:** add Serper v7 workflows and mini-batch guidance ([c066307](https://github.com/xapi-labs/xapi-cli/commit/c066307f2fb8a0b3a4746fcb25f67d3853b4374d))

## [0.1.19](https://github.com/xapi-labs/xapi-cli/compare/v0.1.18...v0.1.19) (2026-08-10)


### Features

* **cli:** add streaming and batch action support ([57c3de6](https://github.com/xapi-labs/xapi-cli/commit/57c3de69a988d8ceb031e64f0c102fe2395854c0))
* **search:** add action sort modes ([c9afd43](https://github.com/xapi-labs/xapi-cli/commit/c9afd4384a02d723fdfd482293d1c0470a4a39ac))
* **skill:** add robust tweet video downloads ([77519f3](https://github.com/xapi-labs/xapi-cli/commit/77519f3c366c751926611d5c5adce943987cfbd4))


### Bug Fixes

* **cli:** harden command safety and transfers ([83615d0](https://github.com/xapi-labs/xapi-cli/commit/83615d04a375ed0ae0826b02d43c9e47cb8bcd82))
* **skill:** correct LinkedIn capability guidance ([442d20a](https://github.com/xapi-labs/xapi-cli/commit/442d20a55e6273c42b29332220119730935bb9b4))


### Documentation

* **skill:** correct capability guidance ([5d92829](https://github.com/xapi-labs/xapi-cli/commit/5d9282982e449d3f586cfc9aa8d1de6d1e59b2ee))
* **skill:** document gateway and cli updates ([157c653](https://github.com/xapi-labs/xapi-cli/commit/157c6535a2ca61955542f44472225ecf7d292655))
* **skill:** rename audio capability IDs ([1757fb6](https://github.com/xapi-labs/xapi-cli/commit/1757fb669442d5783ec9b84f0c2921756880ab61))
* **skill:** sync capabilities and gateway guides ([e20d1b8](https://github.com/xapi-labs/xapi-cli/commit/e20d1b83a4f692e60c83fdddd054dc32697d956f))
