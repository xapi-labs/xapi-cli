# Changelog

## [0.2.1](https://github.com/xapi-labs/xapi-cli/compare/v0.2.0...v0.2.1) (2026-09-29)


### Bug Fixes

* **cli:** respect polling delays when timers wake early ([b5333eb](https://github.com/xapi-labs/xapi-cli/commit/b5333eb3a9822425283d84c023b3448d41cb0911))
* **cli:** respect polling delays when timers wake early ([03a98ea](https://github.com/xapi-labs/xapi-cli/commit/03a98eac7e365759b243c40d503dab5429d4e344))

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
