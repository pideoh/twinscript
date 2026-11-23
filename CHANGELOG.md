# Changelog

## [0.11.0](https://github.com/pideoh/twinscript/compare/v0.10.0...v0.11.0) (2026-11-23)


### Features

* keep a finished sentence's translation when it already covers the sentence ([#70](https://github.com/pideoh/twinscript/issues/70)) ([212b96d](https://github.com/pideoh/twinscript/commit/212b96d66cdc1a1536c6bac47fb634813e130b97))


### Performance

* save one sentence at a time and load transcripts only when a session is opened ([#71](https://github.com/pideoh/twinscript/issues/71)) ([806061e](https://github.com/pideoh/twinscript/commit/806061edd12b4d599c2dd88b1c73c8fddfa9a75b))

## [0.10.0](https://github.com/pideoh/twinscript/compare/v0.9.0...v0.10.0) (2026-11-23)


### Features

* extend the translation of a sentence in progress instead of rewriting it ([#69](https://github.com/pideoh/twinscript/issues/69)) ([a039ab5](https://github.com/pideoh/twinscript/commit/a039ab536fa97abb1ea53d9203e20d9a6201abc1))
* **tuning:** add steady, carry and chunk pacing strategies behind the debug switch ([#66](https://github.com/pideoh/twinscript/issues/66)) ([b283229](https://github.com/pideoh/twinscript/commit/b283229a689924e37f9b5f8b6485a093853703ae))


### Bug Fixes

* do not send a redundant thinking option to the default translation model ([b49176f](https://github.com/pideoh/twinscript/commit/b49176f424fc1c9fb4edbb233c1930f3f41f9d6a))

## [0.9.0](https://github.com/pideoh/twinscript/compare/v0.8.0...v0.9.0) (2026-11-23)


### Features

* lead every line with its language code and keep the header on one row ([#61](https://github.com/pideoh/twinscript/issues/61)) ([e8e704c](https://github.com/pideoh/twinscript/commit/e8e704cf176a3bd72be66555685aaae6b3b8611c))
* translate speech in an unselected language into all selected languages by default ([#57](https://github.com/pideoh/twinscript/issues/57)) ([24d64ab](https://github.com/pideoh/twinscript/commit/24d64ab9869b4c6038f64a9efd938b3152794f35))


### Bug Fixes

* keep three sentences in the caption area with a third language ([#55](https://github.com/pideoh/twinscript/issues/55)) ([95a3f36](https://github.com/pideoh/twinscript/commit/95a3f36afd4804d44716b02388b17426feb5820c))
* lead each translation with a short fixed-width language code ([#59](https://github.com/pideoh/twinscript/issues/59)) ([a733fda](https://github.com/pideoh/twinscript/commit/a733fda7e0ca31e2131cf09bcb26238f5174f1da))
* translate short Japanese interjections into the other language ([e710e7b](https://github.com/pideoh/twinscript/commit/e710e7b8208695047289e4ef84f803ca3c7842a5))
* translate short Japanese interjections into the other language ([e70c0d1](https://github.com/pideoh/twinscript/commit/e70c0d1072f16ac53513e05d127145ecc15948e0))
