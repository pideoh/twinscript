# Changelog

## [0.15.0](https://github.com/pideoh/twinscript/compare/v0.14.0...v0.15.0) (2026-11-25)


### Features

* retry a translation after a passing server error ([#150](https://github.com/pideoh/twinscript/issues/150)) ([8219a13](https://github.com/pideoh/twinscript/commit/8219a130744602b9e21c09efea62fe21b7fca5b0)), closes [#147](https://github.com/pideoh/twinscript/issues/147)


### Bug Fixes

* count listening time once while the usage dialog is open ([#136](https://github.com/pideoh/twinscript/issues/136)) ([91e3dac](https://github.com/pideoh/twinscript/commit/91e3dacda8fb42b2d4e05ace6dc284510e511a25)), closes [#128](https://github.com/pideoh/twinscript/issues/128)
* do not export or summarize before the saved sessions have loaded ([#137](https://github.com/pideoh/twinscript/issues/137)) ([63be8fd](https://github.com/pideoh/twinscript/commit/63be8fd62d0f653882659233d6c013ca1cb6fccb)), closes [#123](https://github.com/pideoh/twinscript/issues/123)
* do not offer speaker labels in the demo ([#138](https://github.com/pideoh/twinscript/issues/138)) ([793460b](https://github.com/pideoh/twinscript/commit/793460b62e768a0b205fc4cf5b992907785502d0)), closes [#130](https://github.com/pideoh/twinscript/issues/130)
* do not start before the saved sessions have loaded ([#121](https://github.com/pideoh/twinscript/issues/121)) ([3aecaad](https://github.com/pideoh/twinscript/commit/3aecaad9fed59a0f72bddc5386ad6c83ae9ed6f4))
* keep a deleted session deleted while work on it finishes ([#139](https://github.com/pideoh/twinscript/issues/139)) ([d8df8eb](https://github.com/pideoh/twinscript/commit/d8df8eb9350982749ccfcef35ff727a35253db33)), closes [#122](https://github.com/pideoh/twinscript/issues/122)
* say so when no translation comes back ([#151](https://github.com/pideoh/twinscript/issues/151)) ([fe373ff](https://github.com/pideoh/twinscript/commit/fe373ff8affbd481f1b8a5d6ef5b7f0d674aa561)), closes [#148](https://github.com/pideoh/twinscript/issues/148)
* stream the final translation after a sentence shown in several languages ([#134](https://github.com/pideoh/twinscript/issues/134)) ([8b502d4](https://github.com/pideoh/twinscript/commit/8b502d44e7be4a3341aba116aca355ca44a53a30)), closes [#132](https://github.com/pideoh/twinscript/issues/132)
* swap the two languages when one is set to the other's ([#146](https://github.com/pideoh/twinscript/issues/146)) ([4b521f4](https://github.com/pideoh/twinscript/commit/4b521f4f0c8f8c78a9504962634b4f0808aeaf19)), closes [#144](https://github.com/pideoh/twinscript/issues/144)

## [0.14.0](https://github.com/pideoh/twinscript/compare/v0.13.0...v0.14.0) (2026-11-25)


### Features

* say when a newer version is available ([#110](https://github.com/pideoh/twinscript/issues/110)) ([a73b31a](https://github.com/pideoh/twinscript/commit/a73b31a4fce816c7f281299bba29fcaa1066f68e))

## [0.13.0](https://github.com/pideoh/twinscript/compare/v0.12.0...v0.13.0) (2026-11-25)


### Features

* read translations aloud in three-language sessions ([#104](https://github.com/pideoh/twinscript/issues/104)) ([a6b4986](https://github.com/pideoh/twinscript/commit/a6b49862fe53537e83329f43cfeaa47ba7937b5c))

## [0.12.0](https://github.com/pideoh/twinscript/compare/v0.11.0...v0.12.0) (2026-11-23)


### Features

* label the speakers of a session from its recording ([#79](https://github.com/pideoh/twinscript/issues/79)) ([d7eba37](https://github.com/pideoh/twinscript/commit/d7eba37f4f94fcb027f42886dfb654d6f7438f75))
* make summaries from templates, as often as wanted, and keep them all ([#75](https://github.com/pideoh/twinscript/issues/75)) ([82ac269](https://github.com/pideoh/twinscript/commit/82ac269ce293de233a10fb4ecb67ecc3bc244ebf))
* show what each session used and an estimate of its cost ([#77](https://github.com/pideoh/twinscript/issues/77)) ([417f560](https://github.com/pideoh/twinscript/commit/417f56081ae922603368549a5fcccd060f4877f1))


### Bug Fixes

* keep the API key out of the live connection's address ([#74](https://github.com/pideoh/twinscript/issues/74)) ([abb3d6e](https://github.com/pideoh/twinscript/commit/abb3d6e0f75746386c0245000e6f8139921ee546))
* show the language codes of a saved session after it is opened again ([#78](https://github.com/pideoh/twinscript/issues/78)) ([d9235c0](https://github.com/pideoh/twinscript/commit/d9235c066f398f1475879eebb14164365c919813))

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
