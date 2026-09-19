# Codex Building Handoff

Last updated: 2026-07-04

## Current Status - Rooms Crosscheck Gate + L3 Renovation COMPLETED 2026-07-04

ROOMS-CROSSCHECK-THEN-L3-RENOVATION complete (report `.tmp/RENOVATION_TASK_REPORT-2026-07-04.json`; commits `b712aa43`, `e351b8e1`, `d31dae3c`, `8eeab6ed`):

- approval conditions written into `docs/RENOVATION_FLOW_DESIGN.md` and committed first (dirty-baseline-on-abandon; one-hop exemption HARD-CHECKED at grant time) — design is now in force.
- STEP 1 (gate tighten, committed separately `e351b8e1`): `roomsStoryCrosscheck` hard-gate check — declared-rooms story counting is cross-checked against the air-pocket heuristic restricted to entrance-REACHABLE interior cells; reachable stories > declared → FAIL. Sealed voids (gabled attic, raw heuristic [1,5,9]) stay exempt via unreachability. Full matrix vs the 2026-07-03 baseline: failure sets identical for all 10 blueprints (delta=0); underdeclared-two-story inline fixture pinned MUST-FAIL (`testRoomsCrosscheckFailsUnderdeclaredTwoStory`).
- STEP 2 mechanism (`d31dae3c`): renovationOf/renovationBaseHash lineage in the run store; `renovation_of_completed_run` decision branch (target COMPLETED + bounds overlap + live base-match scan; fresh/RECONCILIATION rules untouched — renovation intent that fails validation blocks); reconciliation-style demolition steps (`renovation_clear`, persisted marker, clear-policy authorized only for the matching lineage run); protected-buildings roster lineage dedup + ABANDONED fallback + active-renovation bounds union + one-hop renovationOf dig exemption hard-checked at grant (transitive chains rejected + logged). Unit tests across construction-run-store/protected-buildings suites.
- L3 RENOVATION BUILT AND ACCEPTED: run `construction_run_d98c8abfd336273a` (renovationOf `construction_run_5732e11c173a524d`, base hash `d2bc5419...`, H_new `9cfcf421...`), 189/189 steps verified, COMPLETED, pure survival, zero commands, zero manual block fixes. Live decision `renovation_of_completed_run` baseMatched=443/443. Demolition-first timing clean (87 clears / 65 places on site, 0 clear-after-place violations; old roof 58 clears, old stairs 11).
- strict WorldDiff (H_new frozen IR): 468/468 verified, missing/wrong/criticalWrongStates 0/0/0, extra/dirt/scaffold 0/0/0; habitability over ACTUAL world blocks all-pass incl. body-width stair sim AND the new rooms crosscheck (declared [1,5] = reachable [1,5]).
- STAIR_CLIMB_LIVE_TEST (the renovation's reason to exist): bot entered by the front door, walked ground→second floor (y 80→84) up the new x=2..5 stairs in ~10s, returned and walked out — ZERO digs, zero stuck. `.tmp/renovation-stair-climb-2026-07-03T17-49-38-929Z.json`.
- neighbors not degraded: pirbaba 16 scalar fields vs 2026-06-30 user-accepted baseline delta=0; GEN2 183/183 all-zero DONE. Real dig probes at both buildings hard-refused with full `[PROTECTED_BUILDING_DIG_BLOCKED]` lines, blocks intact (honesty note: the two mid-construction full-stack probe attempts couldn't REACH the targets over no-dig pathing — move_timeout, zero damage; the refusal evidence was captured immediately post-completion at close range; guard-level protection was enrolled throughout).
- roster transition: R_old got EXACTLY ONE new field `supersededByRenovation` (updatedAt byte-unchanged, all other runs byte-identical, 19 runs total); roster = exactly 3 regions (pirbaba/GEN2/R_new 508..518,78..92,51..61); reverse probes: old-box points attribute to R_new, foreign runIds refused, R_old runId no longer exempts.
- forward-fix during the build (committed `8eeab6ed` with tests): axis-log (ridge) placement gained temporary-reference support — axis-constrained offsets + side-attached temp columns (9 ridge oak_log axis=x steps had terminal_failed with `stateful_axis_no_x_reference`; all placed after the fix, temp blocks cleared).
- operational findings: door-aware pathfinding still missing (worked around by survival door interaction + direct-control walk between batches — `.tmp/renovation-enter-exit-house.js`); interior clear steps prefer outside stands and can move_timeout on a sealed house (pre-positioning the bot inside resolves it); post-completion residue polish cleared 43 temp-reference/work-platform blocks via run-exempt survival digging (same pattern as the original L3 build).
- provenCapability (new): 对已完工建筑的对账式翻新(拆旧建新、renovationOf 承继、一跳豁免硬检查、名册世代切换)、rooms 交叉校验闸门(可达性语义)、真山墙屋顶(含屋脊轴向原木临时参照)、实测楼梯爬升验证。

## Previous Status - Micro-Run Retirement, Stair/Roof Generator Fix, Body-Width Stair Gate 2026-07-03

User-approved follow-ups executed (commits `a90e0416`, `adf2d459`; report `.tmp/MICRO_RETIRE_AND_FIX_TASK_REPORT-2026-07-03.json`):

- micro-run retirement (approved): one_block x2 + two_blocks converged COMPLETED -> ABANDONED (reason TEST_FIXTURE_LEAK_RETIRED_FROM_PROTECTION_ROSTER), state fields only, byte discipline, 0 deletions. Roster now EXACTLY 3 (pirbaba, GEN2, L3); 5-point reverse probe over the old origin boxes all allowed (no residual protection), positive probes on the three real buildings still blocked.
- expansion (approved): six_blocks + high_block ACTIVE zombies forensically confirmed as the same 2026-06-21 mock test batch (sub-second step cadence; high_block validate_world failed on air even in-test) and converged ACTIVE -> ABANDONED. The run store now has ZERO ACTIVE runs (18 = 15 ABANDONED + 3 COMPLETED). Origin field check remains OP-delegated.
- generator fix (decision 2a): simple_two_story_cabin stairs moved to x=2..5 with a head-on mount walkway; stairwell headroom for both straddled columns per rise; simpleGabledStairRoof (oak_stairs slopes + oak_log ridge + plank gable ends) replaces the stepped plank mesa — 468 blocks <= 500 budget; simple_wood_cabin regression byte-identical; offline precheck green (467 steps, 0 diagnostics, canonical phase sim 0 violations, materials incl. oak_stairs 76).
- gate tightening (decision 2a): verticalTransitionAllowed now models the 0.6-wide body (air at [upperFeet, upperFeet+1] in BOTH columns of a rise/drop); detectStories uses declared required-room floor levels so the new attic void does not extend the stair requirement. Regression test pins the old L3 stair geometry as MUST-FAIL and the new geometry as MUST-PASS. Regression matrix `.tmp/blueprint-regression-matrix-2026-07-03.json`: GEN2 passes old+new gate; all 8 legacy/decorative templates have identical failure sets before/after (tightening introduced zero new failures). L3's historical acceptance is NOT retroactively voided — the standing building is marked PENDING RENOVATION.
- renovation flow design (decision 2b, DESIGN ONLY): `docs/RENOVATION_FLOW_DESIGN.md` — explicit RENOVATION run type with renovationOf lineage, no RECONCILIATION bypass, one-hop runId exemption chain, roster dedup by lineage, new-hash strict WorldDiff acceptance, forward-fix resume semantics (no auto-rollback). Zero construction, zero run-store writes. Renovation build itself awaits design approval and a separate session.

## Previous Status - Zombie Run Cleanup, pirbaba Enrolled in Protection Roster 2026-07-03

ZOMBIE-RUN-CLEANUP-AND-PROTECTION-ROSTER complete (report `.tmp/ZOMBIE_RUN_CLEANUP_TASK_REPORT-2026-07-03.json`):

- pirbaba `construction_run_c57fec1bd503f07e` converged ACTIVE -> COMPLETED/COMPLETED/USER_ACCEPTED_FINAL — state fields only (status/terminalState/finalStatus/updatedAt), non-state fields byte-identical (asserted pre/post, backups in .tmp). Now auto-enrolled in the protection roster (bounds 604..619/65..87/-65..-52 with margin); live dig probe on a real spruce_log wall block hard-refused with a complete `[PROTECTED_BUILDING_DIG_BLOCKED]` line; strict WorldDiff after convergence: 16 scalar fields vs the 2026-06-30 user-accepted baseline, delta 0. The documented "pirbaba only protected by convention" exposure is closed.
- small_house zombie `construction_run_8617bc13bcda2cab` converged ACTIVE -> ABANDONED (reason ZOMBIE_RUN_CLEANUP_NO_BLOCKS_EVER_PLACED). Forensics: created in the 2026-06-21 06:54:04-09 test batch, 116 steps = 1 ready + 115 pending, ZERO blocks ever placed — no building exists to protect; correctly NOT in the roster.
- whitelist cross-check spanning both store writes: GEN2 / L3 / L3-attempt1 / three micro runs / six_blocks / high_block all byte-identical; exactly 2 records changed, none deleted (18 -> 18).
- three micro COMPLETED runs (one_block x2, two_blocks at world origin): verdict RETIRE recommended, NOT executed, records untouched — they are test-leak fixtures from the same 4-second batch whose protection boxes sit on world origin. Awaiting user approval; suggested mechanism: state-field-only convergence to a non-enrolling terminal with the same byte-compare discipline.
- out-of-scope observations flagged: six_blocks + high_block are ACTIVE zombies from the same test batch (untouched); root cause of the batch was tests writing to the production run store on 2026-06-21 (unit tests are store-isolated since the CANDIG task).
- incident (reported as-is): the read-only origin site survey trek was cancelled per user direction after the no-dig route crossed an ocean (bot swimming); zero blocks placed/dug during the survey, bot ashore with full inventory. Field verification of the origin micro-sites is delegated to an OP bot/player teleport view — do not send the survival bot on long reconnaissance treks.
- USER FEEDBACK OPEN ITEM (next task candidate): the L3 two-story cabin's stairs are not climbable by a real player (head-collision at the solid slab cell (1,4,4) rel while stepping S1->S2 with a 0.6-wide bounding box; the hard gate's cell-based continuousStairPath passed it — gate model must be tightened to body-width physics) and the "simple_gabled" roof is a stepped plank mesa, not a gable. Fix plan proposed (generator stair relocation + full stairwell opening + real stair-block gabled roof + gate tightening + a renovation flow for the standing building) — awaiting user's choice of scope.

## Previous Status - canDig Hardening + Completed-Building Protection 2026-07-03

CANDIG-HARDENING-AND-COMPLETED-BUILDING-PROTECTION complete (commit `5bf5a86d`): the two protection gaps exposed by the L3 task are closed.

- non-construction movement no longer digs by default: `actions/move.js` `configureMovements` flipped `canDig ?? true` -> `?? false` (gathering/pickup/farm/explore/smelting/auto-prep/return-to-base/sleep/follow all inherited true before); `bot.js` `mkMovements` (move_to/follow/pickup/come command paths) additionally disables dirt scaffold towers. Construction moves unaffected — build.js/building-system already pass canDig explicitly per purpose (largeVerticalTravel, adaptiveRepairClear, adaptiveCleanup remain deliberate true). Full call-site inventory: `.tmp/CANDIG_PROTECTION_TASK_REPORT-2026-07-03.json`.
- completed buildings are now protected world regions: `systems/protected-buildings.js` derives regions dynamically from COMPLETED runs in the run store (+1 margin, mtime-cached, nothing hardcoded). Dig guards refuse with `[PROTECTED_BUILDING_DIG_BLOCKED] pos/runId/blueprintId/source` in mine.mineBlock, all build clear paths, farm harvest, mine-nearby task, stuck-recovery safe_dig, and the legacy `dig_block` tool. Exemption strictly per matching runId (`[PROTECTED_BUILDING_DIG_EXEMPT]` logged; building-system `executeStep` publishes `context.activeConstructionRunId` so a run may repair its own building; no global bypass). Pathfinder avoidance implemented: `Movements.exclusionAreasBreak` gets Infinity-penalty exclusions for protected regions whenever a move enables digging.
- note: pirbaba (`construction_run_c57fec1bd503f07e`) is ACTIVE/USER_ACCEPTED_FINAL, not COMPLETED, so it is NOT in the dynamic protected list — its safety still rests on the untouchable-run red line; finalizing it to COMPLETED would enroll it automatically.
- tests: new `tests/protected-buildings.test.js` (regions from run store, guard+log fields, per-runId exemption, movement profile defaults, break exclusions, clear/mine integration with zero-dig assertions). Test harness contexts now set `protectedBuildingRunStorePath` to a nonexistent file — three legacy COMPLETED micro-runs (`one_block` etc.) sit at world origin exactly where mock worlds place blocks. All suites green (six core + protected-buildings, execution-tasks, survival, farming, exploration, systems, auto-preparation, storage, crafting, commands, identity).
- live verification (no new building): a round trip whose straight line crosses the L3 cabin footprint completed via detour (3/3 legs); a deliberate mineBlock at the L3 wall was refused pre-dig with the full log line; strict diffs of all three buildings after the trip: L3 445/445 all-zero DONE=true, GEN2 183/183 all-zero DONE=true, pirbaba counters byte-identical to its user-accepted 2026-06-30 baseline. blocksDamaged=0.
- operational finding: the bot had logged out INSIDE the sealed L3 cabin; with no-dig movement it could not path out (clean move_timeout x3, zero damage — the hardening even prevents self-liberation through walls) and the pathfinder does not route through door blocks even when open. Exit required a survival door interaction + direct-control walk-through. Follow-up candidate: door-aware pathfinding (Movements.canOpenDoors or a door-passage helper) for interior work after doors_windows phase.
- reports: `.tmp/CANDIG_PROTECTION_TASK_REPORT-2026-07-03.json`, `.tmp/l3-protection-live-verify-2026-07-03T06-56-02-215Z.json`, `.tmp/strict-final-worlddiff-v2-2026-07-03T06-57-18-201Z.json`.

## Previous Status - L3 Two-Story Cabin Built, Strict WorldDiff Green, fresh_natural_terrain Live-Validated 2026-07-03

GENERATOR-COMMON-LAYER-FIX-AND-L3-TWO-STORY-BUILD complete: third-building generalization PASSED — procedural `simple_two_story_cabin` (445 IR blocks, 2 stories, real stairs) built from zero in pure survival with full material autonomy, and the rescue-detection natural-terrain auto decision was validated live for the first time.

- runId: `construction_run_5732e11c173a524d` — `status=COMPLETED`, `terminalState=COMPLETED`, 448/448 steps verified, archive attached. Origin `(509,79,53)`, bounds `x=509..517 y=79..89 z=52..60` (143 from pirbaba ≥30, 20 from GEN2 cabin ≥15).
- decision=fresh_natural_terrain live validation (task goal): first launch logged `[BUILD_SITE_CLASSIFICATION] detected=40 natural=40 blueprintMatching=0 unknown=0 decision=fresh_natural_terrain` with `escapeHatchUsed=false` and NO `allowOverwriteExistingStructure`/`forceRebuild` anywhere; zero `[BUILD_OVERWRITE_ESCAPE_HATCH]` lines. GEN2's manual probe + overwrite opt-in is no longer needed on natural sites.
- strict final WorldDiff `.tmp/l3-strict-worlddiff-2026-07-03T06-08-55-088Z.json`: `DONE=true`, 445/445 verified, missing/wrong/wrongStates/criticalWrongStates = 0/0/0/0, extraBlocks/extraDirt/scaffoldResidue = 0/0/0. Door lower+upper `facing=south` exact; bed foot `(2,5,1)` + head `(2,5,2)` `facing=south` exact; 4 standing `torch` exact (no wall_torch); 4 `oak_stairs facing=east half=bottom shape=straight` exact.
- habitability over ACTUAL world blocks (requiredStories=2): pass — detectedStories=2, continuousStairPath=true (climbable), roof coverage, functional blocks usable.
- secondFloorDependencyRespected=true from `[BUILD_STEP]` execution logs (all story-1 frame posts before the first slab step; slab complete before story-2 walls); the runtime canonical phase barrier also enforced it live (attempt-1 was hard-blocked by `phase_dependency_incomplete`).
- generator common layer (commit `4a5f5920`): shared `placeBedPair` (vanilla foot->head convention) + `placeFloorTorch` (generation-time solid-support validation, throws on floating torches); `simple_wood_cabin` refactored onto the helpers with byte-identical output vs its GEN2-verified baseline; `simple_two_story_cabin` white_wool placeholder replaced by a real bed pair on second-floor planks (old anchor hung over the stairwell opening) and 4 floating torches moved onto floor planks.
- root causes fixed during the live build (each with tests, all suites green):
  - `systems/procedural-blueprint-generator.js` (commit `0ebb5bfb`) — story-2 corner posts retagged `frame`->`wall`: the runtime executes canonical phases with a hard barrier (frame->floor->wall), so story-2 corners tagged `frame` were scheduled before the second-floor slab and only reachable via fragile 7-high temp columns (attempt-1 run `construction_run_37f0041d208e745e` stalled on `place_failed:unstable:dirt`; superseded run cleaned up in-world and ABANDONED with reason `blueprintHash_changed`).
  - `actions/build.js` (commit `b1d9e5a8`) — standing torches restrict placement references to the block below; side-face placement converts to `wall_torch` (live terminal_failed at the two-wall interior corner rel `(1,1,1)`).
  - `actions/build.js` (commit `5494b47b`) — bed placement keeps the oriented yaw via `_genericPlace forceLook:'ignore'`; `bot.placeBlock`'s internal re-look overrode `orientBotForPlacement` and the bed landed `facing=east`.
- material autonomy (fully survival): base-chest withdraw (iron/coal/cobble) -> bare-hand bootstrap -> crafting table -> iron tools -> ~90 oak logs chopped -> 362 planks -> stairs/torches/furnace/tables -> sand mined + smelted to glass -> 3 wool sheared at the (575,128,70) sheep cluster -> white_bed. Incidents (all recovered without manual supply): inventory overflow from oak_leaves (junk-deposit list extended), 3x3 crafts away from table (`ensureTableNearby`), smelt-retrieval assert leaving furnace+glass in a temp furnace (protected-clear recovery), orphan bed halves (protected-clear + item recovery), torch stock consumed by wall_torch cycles (re-crafted).
- operational pitfall recorded: `moveTo`'s `canDig` DEFAULTS TRUE (`actions/move.js:34`) — observer/pickup pathing dug through finished walls twice during acceptance. Every read-only probe, diff, and polish script must pass `canDig:false`; `mine.mineBlock`'s internal move and the pickup-confirm layer still dig by default (future hardening candidate).
- post-completion strict polish (pirbaba precedent, survival only, no commands): 22 executor temp-reference dirt residue blocks dug and 15 observer-damaged wall/slab planks re-placed before the final green diff.
- protected runs untouched: pirbaba `construction_run_c57fec1bd503f07e` ACTIVE with unchanged `updatedAt`; GEN2 `construction_run_bf367727a713470a` COMPLETED unchanged; both legacy ACTIVE runs byte-identical across every batch.
- consolidated report: `.tmp/L3_TWO_STORY_TASK_REPORT-2026-07-03.json`; driver scripts `.tmp/l3-*.js` (site probe, material probe, procurement, live build, strict diff, polish).
- known limitation (carried from the rescue-detection fix, still open): blueprints whose leading steps place natural-typed blocks (dirt/grass terrain fill) have a narrow window where, if the construction-run record is lost, a partially-built site can be misclassified FRESH — the natural-block whitelist cannot distinguish bot-placed dirt from terrain. Mitigation relies on run-store integrity (atomic tmp-file writes); do not widen the whitelist.
- provenCapability (updated): 第三建筑泛化（双层结构、真实楼梯爬升路径）、fresh_natural_terrain 自动决策真实验证（零逃生舱）、生成器公共层床/火把修复（simple_wood_cabin 回归字节一致）、完全材料自治（含羊毛链与玻璃链）、真床二层放置（朝向精确）、站立火把精确放置（双墙角落）。
- notYetProven: 游戏内自然语言命令 E2E；mine/pickup 路径的 canDig 默认值加固。

## Previous Status - Rescue Detection Natural-Terrain False Positive Fixed 2026-07-03

RESCUE-DETECTION-NATURAL-TERRAIN-FALSE-POSITIVE-FIX (offline, engine + tests only):

- root cause fixed: `decideConstructionRunStart` blocked any fresh build once >=16 non-air blocks sat at expected positions — natural ground at foundation level always triggered `EXISTING_STRUCTURE_DETECTED_NEEDS_RECONCILIATION` (GEN2 needed a manual probe + `allowOverwriteExistingStructure`).
- new double-signal rule in `systems/building-system.js`:
  - `blueprintMatchingBlocks > 0` (type match at expected position, wrong-states matches included, matches on natural terrain types like dirt/grass terrain fill excluded) → forced RECONCILIATION, NOT bypassable by `allowOverwriteExistingStructure`/`forceRebuild`.
  - all detected blocks natural (position-independent whitelist `NATURAL_SITE_BLOCKS` + `*_leaves`/`*_sapling`; logs deliberately excluded) → automatic FRESH.
  - unknown artificial blocks >= threshold → `UNKNOWN_ARTIFICIAL_BLOCKS_REQUIRE_MANUAL_DECISION`; `allowOverwriteExistingStructure` demoted to an escape hatch for THIS case only, with `[BUILD_OVERWRITE_ESCAPE_HATCH]` log and `escapeHatchUsed` recorded; below-threshold obstructions keep flowing into the normal clear/repair path (status quo).
  - every decision logs `[BUILD_SITE_CLASSIFICATION] detected/natural/blueprintMatching/unknown/decision`; successful `buildBlueprint` results now carry `constructionRunDecision`.
- regression tests (tests/construction-run-store.test.js): GEN2 49-grass replay → auto FRESH; partial build + overwrite flag → still RECONCILIATION; mixed 48 natural + 1 matching → RECONCILIATION; foreign artificial blocks → manual decision + escape hatch path; natural tree logs → manual-decision branch at threshold (conservative, leaves natural). All six suites green.
- report: `.tmp/DECISION_LOGIC_REPORT-rescue-natural-terrain-fix-2026-07-03.json`. `bypassStillRequiredForNaturalSites=false`.
- live validation pending: next real build on a natural site should show `decision=fresh_natural_terrain` without any overwrite env/flag.

## Previous Status - GEN2-SIMPLE-CABIN LIVE BUILD DONE, Strict WorldDiff Green 2026-07-02

BUILDING-GEN2-LIVE-SIMPLE-CABIN complete: the second-building generalization test PASSED end-to-end — a procedurally generated blueprint (`simple_wood_cabin`, 183 IR blocks incl. real bed pair) was built from zero at a new site in pure survival with full material autonomy and zero manual block fixes.

- runId: `construction_run_bf367727a713470a` (fresh run; blueprintId `simple_wood_cabin`) — persisted `status=COMPLETED`, `terminalState=COMPLETED`, 234/234 steps verified, archive attached. Placement origin `(508,83,28)`, bounds `x=508..514 y=83..89 z=27..33` (126 blocks from pirbaba, gap rule ≥30 satisfied).
- protected run untouched: `construction_run_c57fec1bd503f07e` remains `ACTIVE/null`, `updatedAt` unchanged (byte-level snapshot asserted before/after every driver batch).
- strict final WorldDiff `.tmp/gen2-strict-worlddiff-2026-07-02T16-13-06-608Z.json`: `DONE=true`, 183/183 verified, `missingBlocks=0`, `wrongBlocks=0`, `wrongStates=0`, `criticalWrongStates=0` (door facing/half AND bed part/facing exact), `extraBlocks=0`, `extraDirtBlocks=0`, `scaffoldResidue=0`. Two grass_blocks at `(506,84,27/28)` were classified as untouched natural hillside via the pirbaba precedent (no construction-run step ever targeted them; recorded, not failed).
- habitability hard gate over the ACTUAL world blocks: 10/10 pass — entrance, interior reachability, roof coverage 1.0, and the real white_bed usable (foot `(1,1,2)` + head `(1,1,3)`, `facing=south`, in-world states exact).
- evidence: `commandsUsed=false`, `manualBlockFixes=0`, new runId, pure survival throughout (movement, digging, placing, crafting, smelting, shearing all via survival actions; no Minecraft commands).
- material autonomy (chain fully survival): deposited 150 junk items to base chests; withdrew cobble/coal/iron; chopped 42+ oak logs (bare-handed, canopy-log blacklist + trunk-first fix after a move_timeout loop the user reported as "keeps returning to base"); crafted 34+ plank recipes, 2 crafting tables, shears, 3 oak doors, white_bed; mined 4 sand; smelted glass in a temporary base furnace (recovered contents from its output slot after an interaction failure; furnace re-crafted from cobble when the temporary one was lost to a protected-clear gap); sheared sheep for 3 white wool (waited through regrow). Reports: `.tmp/gen2-procure-*.json`, `.tmp/gen2-final-topup-*.json`.
- fixes landed this task (all with tests, suites green: blueprint-ir / construction-compiler / construction-runs / building / world-diff / actions):
  - `systems/building-system.js` — bed-head material exemption centralized in `itemRequirementsForStep` (+ early-ok in `ensureMaterialForStep`): runtime material reconciliation was double-counting the bed (`white_bed required=2`) and blocking build start.
  - `actions/smelt.js` — `SMELT_INPUTS` extended with `sand/red_sand -> glass` (+ test): glass autonomy was impossible.
  - plus the earlier precheck-phase fixes (real bed pair in generator, vanilla bed placement convention in `actions/build.js`, bed head->foot dependency in the adapter, floating-torch fix).
- fresh-build-on-terrain note: `decideConstructionRunStart` blocks any fresh build when >=16 non-air blocks exist at expected positions — natural ground at foundation level triggers this (`EXISTING_STRUCTURE_DETECTED_NEEDS_RECONCILIATION`). Per the startup-doc rule the driver opted into `allowOverwriteExistingStructure:true` ONLY after a read-only probe proved `verifiedTargetBlocks=0` and all 49 detected blocks were natural grass_block (`.tmp/gen2-decision-probe-2026-07-02T16-01-05-512Z.json`), with a guard that refuses overwrite if any blueprint-matching block exists.
- driver scripts (reusable pattern): `.tmp/gen2-site-probe.js`, `.tmp/gen2-material-probe.js`, `.tmp/gen2-procure-materials.js` + round2/finish/topup, `.tmp/gen2-live-build.js` (fresh-run guarded, pirbaba snapshot asserted, 3-strike stall stop), `.tmp/gen2-strict-worlddiff.js`.
- provenCapability (updated):
  - 第二建筑泛化（程序化蓝图从零到验收，全新 run，独立场地）
  - 完全材料自治（采集→合成→熔炼→剪羊毛全链，零人工补给）
  - 真实床放置（原版朝向约定，foot+head 状态精确）
  - 简易建筑复杂度自适应（L2 预算路径选中 simple_wood_cabin）
  - fresh-run 决策安全（不干扰任何现存 ACTIVE run）
- notYetProven:
  - 游戏内自然语言命令 E2E
  - simple_two_story_cabin 真实建造（其生成器仍有浮空火把 ×4 + white_wool 床占位，需先修复——同 simple_wood_cabin 的修法）
  - 楼梯/多层建筑的真实爬升路径验证

## Previous Status - GEN2-SIMPLE-CABIN Offline Precheck Passed, Live Build Pending Server 2026-07-02

BUILDING-GEN2-LIVE-SIMPLE-CABIN (step 1 offline precheck complete; step 2 live build blocked on Minecraft LAN availability):

- precheck report: `.tmp/gen2-simple-cabin-precheck-2026-07-02T07-25-29-140Z.json` — all green.
- compile (origin `0,64,0`, rich inventory): 220 steps, 0 error diagnostics, 0 warnings; phases foundation 55, floor 15, frame 12, wall 42, functional_blocks 7, doors_windows 6, roof 81, cleanup 2; dependency order clean.
- hard gate: 10/10 pass; single story `[1]`, roof coverage 1.0, door count 2, all functional blocks usable including both real bed halves.
- bed placeholder finding (task step-2 focus): the old `white_wool` bed passed the gate only vacuously — `BuildingHardGate` FUNCTIONAL_BLOCKS excludes wool (bed skipped) and `WalkabilityChecker.normalizeFurnitureRole` aliases `white_wool` to `bed`. Bed-usable habitability could never be evidenced. Fixed in the generator (no gate thresholds changed).
- fixes landed with tests:
  - `systems/procedural-blueprint-generator.js` — `simpleWoodCabin` now emits a real `white_bed` pair: foot `(1,1,2)` + head `(1,1,3)`, `facing=south`, vanilla convention (facing points foot→head); floating torch `(1,2,1)` moved to floor-supported `(1,1,1)` (a floating torch could only be wall-mounted in-game and would strict-diff as `wall_torch`).
  - `actions/build.js` — bed placement convention was inverted vs vanilla and never live-validated (pirbaba's bed was removed by habitabilityAdaptation and manually placed by the user): `placementLookDirection` now looks toward `+facing` for the foot; `tryPlaceBedPairFallback` partner = `target + facing` with reverse look. Tests in `tests/actions.test.js` updated to vanilla convention.
  - `systems/blueprint-compatibility-adapter.js` — bed head now depends on bed foot (like door upper→lower); test in `tests/blueprint-ir.test.js`.
  - `utils/building-material-map.js` (`isBedHeadBlockState`) + `utils/site-planner.js` + `systems/construction-compiler.js` — bed head no longer double-counts a second bed item in material plans; test in `tests/construction-compiler.test.js`; generator test in `tests/blueprint-building.test.js`.
- materials (formalRequired, all exact-required, strict-by-default): oak_planks 131, cobblestone 20, oak_log 19, glass 4, torch 2, oak_door 2, white_bed 1, chest 1, crafting_table 1, furnace 1 (+ site-dependent dirt support fill).
- run decision verified read-only: no run has `blueprintId=simple_wood_cabin`; `findActiveCompatible`/`findActiveForBlueprint` both null → fresh run; pirbaba `construction_run_c57fec1bd503f07e` and legacy `small_house` ACTIVE run are `blueprintId_changed`-incompatible and not touched; run store bytes unchanged.
- tests: `test:blueprint-ir`, `test:construction-compiler`, `test:construction-runs`, `test:building`, `test:world-diff`, `test:actions` all pass after the fixes.
- offline smoke of live path: `previewBlueprint(ctx,'simple_wood_cabin',origin,{rawText:'build simple wood cabin',complexityTier:'L2',explicitOrigin:true})` → `procedural_fallback`, layer `complexity_budget_preserved`, 220 steps; `decideConstructionRunStart` → `fresh`/`NO_ACTIVE_RUN`.
- live-phase blockers/prep:
  - Minecraft LAN world is currently CLOSED (no java process; port scan empty; last bot log 2026-07-02T07:27Z). ONLINE-GATE passed earlier today (bot log 06:29Z: TickLoop started, 上线成功, botUsername=LinXia) but the live build needs the server reopened AND a bot restart to load the fixed `actions/build.js` (the stale-code bot process was stopped per runbook).
  - prepared driver scripts: `.tmp/gen2-site-probe.js` (read-only ONLINE-GATE + flat-site scan + chest listing; run first), `.tmp/gen2-live-build.js` (`GEN2_ORIGIN="x,y,z"`; fresh-run guarded, pirbaba-snapshot asserted, 3-strike stall stop, no commands).
  - material outlook from last known inventory (oak_log 4, oak_planks 8, dirt 65, torch 2, furnace 1, chest 5, iron_pickaxe, stone_shovel): needs ~40 oak logs (chop), ~20 cobblestone (mine), 4 glass (sand+smelt), 3 white wool (sheep/string) for the bed — gathering→craft chain, pure survival.
- follow-up noted (not this task): `simple_two_story_cabin` still has 4 floating torches and a `white_wool` bed placeholder; same generator fixes should be applied before its own live build.

## Current Status - GEN2-PHASE0 Offline Precheck Passed 2026-07-02

BUILDING-GEN2-PHASE0-OFFLINE-PRECHECK (second-building generalization, offline only):

- scope: fully offline; no bot startup, no server connection, zero block operations, zero touches to any existing construction run.
- blueprint: procedural `simpleTwoStoryCabin` (`systems/procedural-blueprint-generator.js`), pipeline `ProceduralBlueprintGenerator -> LegacyBlueprintAdapter -> BlueprintIR v1 -> ConstructionCompiler`.
- report: `.tmp/gen2-phase0-precheck-2026-07-02T06-56-11-094Z.json`
- template fix (blueprint side, no gate thresholds changed): the second-floor slab (y=4) had no stairwell opening above the stair run — the single opening at `(2,4,4)... (4,4,4)` was only `(4,4,4)` and it was immediately overwritten by the top `oak_stairs` step, so climbing was head-blocked at `(2,4,4)` and feet-blocked at `(3,4,4)`. Hard gate failed `continuousStairPath` and `allRequiredRoomsReachable` (upper_sleeping). Fixed by opening stairwell cells `(2,4,4)` and `(3,4,4)` in `simpleTwoStoryCabin`.
- compile (placement origin `0,64,0`, empty site snapshot, rich inventory): `ok=true`, 0 error diagnostics, 0 warnings, `missingMaterials=[]`. 507 steps: foundation 91, floor 95, frame 24, wall 134, stairs 4, doors_windows 10, roof 139, functional_blocks 8, cleanup 2. Dependency order: `validateStepDependencyOrder` clean plus independent re-check 0 violations. `blueprintHash=5e70ede50ee5bb1f55ad98f431f34ff92aa69060`, `planId=construction_plan_86a42e94206b` (placeholder-origin values; real placement will differ).
- hard gate after fix: all 10 checks pass — door count 2, shell leak 0, exposed interior 0, roof coverage 1.0, stories `[1,5]` (2 detected), continuous stair path true, all required rooms reachable, all functional blocks usable, scaffold residue 0, volume/footprint within budget.
- materials (formalRequired, all exact-required under `material_policy:strict_default`): oak_planks 359, oak_log 33, cobblestone 28, glass 8, oak_stairs 4, torch 4, oak_door 2, chest 1, crafting_table 1, furnace 1, white_wool 1 (bed placeholder). Substitution is only possible via terrain-role terrain fill or run-scoped user-approved overrides; no compile-time substitutable structural blocks. An extra `dirt 63` in `materials.required` is planner support/fill for the empty placeholder site, site-dependent, not a blueprint material.
- run decision verified read-only: `findActiveCompatible` / `findActiveForBlueprint` match by `blueprintId`; no run in `data/memory/construction-runs.json` has `blueprintId=simple_two_story_cabin`, so both return null and a fresh run would be created. `prepareConstructionRun` only abandons an incompatible ACTIVE run with the SAME blueprintId, so the pirbaba ACTIVE run `construction_run_c57fec1bd503f07e` (`blueprintId_changed` vs cabin criteria) and the legacy ACTIVE `small_house` run `construction_run_8617bc13bcda2cab` are not touched. Other legacy ACTIVE runs (`six_blocks`, `high_block`) likewise unaffected. Run store file bytes verified unchanged after the check.
- tests all pass after the template fix: `test:blueprint-ir`, `test:construction-compiler`, `test:construction-runs`, `test:building`, `test:world-diff`, `test:actions`.
- next phase readiness: offline precheck complete; PHASE1 (online, new site, zero manual block assist) still requires site selection, real placement compile, and material autonomy checks against live inventory.

## Current Goal

LinXia's building system is being moved from an ad hoc `BuildingSystem` flow toward:

```text
user request
-> DesignSpec
-> frozen BlueprintIR
-> ConstructionCompiler
-> ConstructionRun persistence
-> BuildingSystem orchestration
-> MineflayerConstructionExecutor / actions
-> WorldDiff validation
-> repair / cleanup / archive
```

The reason for the BlueprintIR -> Compiler -> Executor -> WorldDiff split is to keep design, block output, execution order, and real-world validation separate. The executor must not invent appearance at placement time, and a restart must be able to reconcile against the real world instead of replaying from memory.

## Current Repository State

- Worktree: `D:\code\MC-blueprint-ir-v1`
- Branch: `refactor/building-blueprint-ir-v1`
- HEAD at start of spruce-log fix: `0b077435b9aa35e32bccd9d8deb226d106b05a5e`
- Latest commit subject at start: `fix(building): allow run-scoped decorative leaf substitution`
- Staged changes at startup check: none observed from `git diff --cached --stat`
- Worktree is dirty. Do not use `git add -A`, `git add .`, `git reset --hard`, or `git clean -fd`.

## Current Status - User Accepted Final House Build 2026-07-01

FIRST_REAL_HOUSE_BUILD_USER_ACCEPTED_FINAL:

- building: P9R faithful community two-story wood house import / 双层木屋
- activeRunId: `construction_run_c57fec1bd503f07e`
- finalStatus: `USER_ACCEPTED_FINAL`
- note: 用户已手动完成最终外观修复，本任务只做确认和记录
- identity: LinXia / 林夏
- noFreshBuild: true
- noNewRun: true
- noForceRebuild: true
- manualCaptureReport: `.tmp/manual-final-house-acceptance-capture-2026-06-30T16-15-18-133Z.json`
- worldDiffReport: `.tmp/strict-final-worlddiff-v2-2026-06-30T16-17-16-784Z.json`
- livability / habitability: scan-supported entrance, first floor movement, second floor reachability, bed presence, livability, and habitability are all true.
- final observation:
  - entrance: scan found three lower spruce door blocks with adjacent passable air.
  - interior: first floor and second floor both have supported passable cells; scan found furnace, smoker, blast furnace, barrels, chests, crafting table, and bed blocks.
  - bed: brown bed exists at `(612,72,-61)` head and `(612,72,-60)` foot.
  - exterior residue: strict v2 reports `scaffoldResidue=0` and `visibleScaffoldResidue=0`; the manual capture heuristic still flags possible cobblestone/temporary platform blocks and records them without repair.
- remainingDiffs: strict v2 remains `ok=false` with `missingBlocks=6`, `wrongBlocks=2`, `extraDirtMustRepair=1`, `wrongRoofStairs=15`, and `criticalWrongStates=25`; these are recorded as accepted manual deviations for this user-accepted final capture, not automatic repair targets.
- safety caveat: the ONLINE-GATE startup used full `bot.js` per startup docs and survival auto-enqueued `return_to_base`; logs show a `safe_dig` recovery attempt at `(610,72,-55)`, and the later read-only scan observed that expected `spruce_planks` block as `air`. No further full bot startup, construction resume, repair, placement, digging, or Minecraft command was run after that observation.
- runtimeStatus: `data/memory/construction-runs.json` still has `status=ACTIVE`, `terminalState=null`, and `finalStatus=null`; runtime memory was not committed.
- provenCapability:
  - resume-only construction
  - staging chest logistics
  - material resolution
  - controlled clear / repair
  - final manual acceptance capture
- notYetProven:
  - 完全材料自治
  - 第二建筑泛化
  - 简易建筑复杂度自适应
  - 游戏内自然语言命令 E2E

## Current Status - Strict Final Polish Repair 2026-06-30

### Confirmed Facts

- Current HEAD at this status update: `9642858a80a01f743a53fd99de738eaaf47e6b0a`.
- Active run remains `construction_run_c57fec1bd503f07e`; preserved placement remains origin `(605,66,-64)`, rotationY `0`, mirror `false/false`, bounds `x=605..618 y=66..86 z=-64..-53`, blueprint hash `bbb81941d7859fd9ed6ff11fd3bad4cab60168ac`.
- Latest controlled resume log for this run recorded `resumeOrFresh=resume`, `freshBuildCreated=false`, `newRunCreated=false`, and `forceRebuildUsed=false`.
- Previous faithful WorldDiff `.tmp/faithful-worlddiff-2026-06-30T12-15-11-221Z.json` recorded `ok=true` under the then-current loose thresholds, but it also recorded `missing=5`, `wrongType=8`, and `wrongState=47`.
- User visual inspection corrected the completion status: extra dirt / dirt scaffold remains, including outside the house, and roof stairs have wrong orientation/state.
- User clarified the remaining work must be completed in pure survival mode: do not use Minecraft commands for movement, item grants, block placement, or block removal.
- Any further dirt / mud / scaffold cleanup must use LinXia's survival actions; if LinXia has a shovel, dirt-like blocks must be dug with the shovel.
- Strict scan `.tmp/strict-final-worlddiff-2026-06-30T14-23-34-449Z.json` confirmed compiled scaffold residue was repaired to `scaffoldResidue=0` using current-build survival cleanup batches.
- Later strict scan `.tmp/strict-final-worlddiff-2026-06-30T14-39-12-302Z.json` still records `extraDirtBlocks=134`, `interiorObstructions=94`, `missingBlocks=5`, `wrongBlocks=11`, and `wrongRoofStairs=0`; `DONE=false`.
- Remaining non-scaffold extra dirt candidates have no construction-run clear/scaffold step IDs. The first low-level batches are `dig_unreachable` / `move_timeout` under pure survival pathing and should not be command-cleared.

### Corrected Status

- Previous status: WorldDiff/livability passed under loose/current thresholds.
- Corrected status: `NEEDS_FINAL_POLISH_REPAIR`; scaffold cleanup is repaired, but strict extra dirt / missing / wrong-block gates remain open.
- `DONE=false` until strict final polish passes.

### Required Final Polish Gate

- Extra dirt or temporary dirt scaffold outside the house must be removed unless that exact position is an expected/resolved BlueprintIR block.
- Roof stair `facing`, `half`, `shape`, and `waterlogged` must match expected state.
- Survival-only repair evidence must record `commandsUsed=false`; command-based helper cleanup must not be used for the remaining work.
- Strict final report must have `extraDirtBlocks=0`, `scaffoldResidue=0`, `wrongRoofStairs=0`, critical `wrongStates=0`, habitability/livability pass, and `failures=[]`.
- Do not fresh build, create a new run, force rebuild, clear the whole site, or treat the loose WorldDiff pass as final completion.

## Current Status - Material Gate After Partial Fence-Gate Recovery 2026-06-29

### Confirmed Facts

- Current HEAD during this update remained `51b4a98bcbd092997c433caa6872e8f0e82f6274`.
- Active run remains `construction_run_c57fec1bd503f07e`; no new construction run, fresh build, force rebuild, or site clear was used.
- Preserved placement:
  - origin `(605,66,-64)`
  - rotationY `0`
  - mirrorX `false`
  - mirrorZ `false`
  - bounds `x=605..618 y=66..86 z=-64..-53`
  - blueprint hash `bbb81941d7859fd9ed6ff11fd3bad4cab60168ac`
- Source fix:
  - `systems/storage-system.js` now deposits partial crafted target items into staging even when `AutoPreparationSystem.ensureItem()` reports `crafted_item_not_available:X/Y`.
  - `ensureStagingMaterials()` retries bounded partial crafting with `maxStagingCraftAttempts` and keeps final `BLOCKED_MATERIAL_SHORTAGE` if verified staging counts are still short.
  - `tests/storage-system.test.js` covers partial `dark_oak_fence_gate` crafting: two crafted gates are deposited, but the result remains blocked for the remaining three gates.
- Validation passed after the fix:
  - `node --check systems\storage-system.js`
  - `node --check tests\storage-system.test.js`
  - `node tests\storage-system.test.js`
  - `node tests\crafting-system.test.js`
  - `node tests\auto-preparation-system.test.js`
  - `npm.cmd run test:identity`
  - `npm.cmd run test:construction-runs`
  - `npm.cmd run test:building`
  - `npm.cmd run test:blueprint-ir`
  - `npm.cmd run test:construction-compiler`
  - `npm.cmd run test:world-diff`
  - `npm.cmd run test:actions`
  - `npm.cmd run test:auto-preparation`
  - `git diff --check` passed with CRLF warnings only.
- Real controlled resume:
  - `.tmp/auto-reconnect-target-mode-2026-06-28T17-45-41-636Z.json`
  - `.tmp/controlled-resume-after-permission-2026-06-28T17-45-42-698Z.json`
  - ONLINE-GATE passed for `LinXia` on port `56168`.
  - `BUILDING_RUN_DECISION` was `resume`, reason `ACTIVE_RUN_COMPATIBLE`.
  - Safety stayed clean: `freshBuildCreated=false`, `newRunCreated=false`, `forceRebuildUsed=false`, `clearedSite=false`, `structuralRemoved=false`, `AndyFallback=false`.
  - The run stopped before block placement with `build_start_failed:BLOCKED_MATERIAL_SHORTAGE:iron_bars:1`.
  - Counts after reconciliation: `verified=844`, `pending=384`, `repair=2`, `state_repair=24`, `cleanup=21`, `terminalState=null`, `currentPhase=frame`.
  - Current next step remains `step_bd4e9dcb1324b476`, `place_block`, `dirt`, target `(607,66,-57)`, phase `frame`, status `pending`.
- Real partial recovery evidence:
  - Logs show `STAGING_CRAFT_PARTIAL item=dark_oak_fence_gate crafted=1 deposited=1 reason=crafted_item_not_available:1/2`.
  - Logs then show `STAGING_CRAFT_SUCCESS item=dark_oak_fence_gate crafted=1 deposited=1`.
  - Staging chest `(603,66,-58)` reached `dark_oak_fence_gate=8`, satisfying the remaining gate backlog.
- Read-only material probe:
  - `.tmp/iron-gate-material-probe-2026-06-28T17-48-15-512Z.json`
  - `BUILD_DECISION` was `resume`.
  - Aggregate material evidence:
    - `iron_bars=2`
    - `iron_ingot=0`
    - `dark_oak_fence_gate=8`
    - `dark_oak_planks=65`
    - dropped `iron_bars=0`
    - dropped `iron_ingot=0`
  - Material gate says backlog requires `iron_bars=3`, available `2`, missing `1`; `canCraftIronBarsFromIngots=false`; `safeToResumeMaterialWise=false`.
- Continuation re-probe:
  - `.tmp/iron-gate-material-probe-2026-06-28T17-52-34-533Z.json`
  - ONLINE-GATE again passed for `LinXia` on port `56168`.
  - Active run and preserved bounds/hash/placement were unchanged.
  - Aggregate material evidence remained unchanged for the blocker: `iron_bars=2`, `iron_ingot=0`, dropped `iron_bars=0`, dropped `iron_ingot=0`.
  - Material gate remained `safeToResumeMaterialWise=false`; no physical resume was attempted from this state.
- Blocked-audit re-probe:
  - `.tmp/iron-gate-material-probe-2026-06-28T17-56-36-376Z.json`
  - ONLINE-GATE again passed for `LinXia` on port `56168`.
  - Active run remained `construction_run_c57fec1bd503f07e`, `status=BLOCKED_MATERIAL_SHORTAGE`, `terminalState=null`, `currentPhase=frame`, `blockedReason=BLOCKED_MATERIAL_SHORTAGE:iron_bars:1`.
  - Counts remained `verified=844`, `pending=384`, `repair=2`, `state_repair=24`, `cleanup=21`.
  - Aggregate material evidence still showed `iron_bars=2`, `iron_ingot=0`, `dark_oak_fence_gate=8`, dropped `iron_bars=0`, dropped `iron_ingot=0`.
  - Material gate still required `iron_bars=3`, available `2`, missing `1`; `canCraftIronBarsFromIngots=false`; `safeToResumeMaterialWise=false`.
  - No physical resume was attempted because the same exact material blocker remained.

### Current Blocker

- Exact material shortage: `iron_bars:1`.
- This is a material/environment blocker, not a resume, placement, WorldDiff, or identity regression.
- `iron_bars` is an exact final block for this blueprint and must not be substituted.
- There are no available `iron_ingot` items in scanned inventory, staging chests, secondary storage chests, or dropped items.
- The same blocker has repeated across consecutive goal continuations after partial gate recovery, so goal-mode progress is blocked until external material is added.

### Next-Step Recommendation

- Add either `1 iron_bars` or enough iron to craft it (`6 iron_ingot`) to reachable staging/storage, then resume the same active run with controlled target mode.
- Do not start a fresh build, create a new construction run, force rebuild, clear the site, or substitute the iron bars.

## Current Status - Hanging Lantern Retry and Entity Blocker 2026-06-28

### Confirmed Facts

- Current HEAD during this update remained `51b4a98bcbd092997c433caa6872e8f0e82f6274`.
- Active run remains `construction_run_c57fec1bd503f07e`; no new construction run, fresh build, force rebuild, or site clear was used.
- Preserved placement:
  - origin `(605,66,-64)`
  - rotationY `0`
  - mirrorX `false`
  - mirrorZ `false`
  - bounds `x=605..618 y=66..86 z=-64..-53`
  - blueprint hash `bbb81941d7859fd9ed6ff11fd3bad4cab60168ac`
- Source fix:
  - `actions/build.js` now passes the active lock owner into hanging-lantern placement.
  - `tryPlaceHangingLantern()` now re-reads the top reference, clears wrong-block or wrong-state misplacements when allowed, retries, and confirms final live block/state.
  - `tests/actions.test.js` adds coverage for clearing a wrong `dirt` block after a hanging-lantern misplacement and retrying to a valid hanging lantern.
- Validation passed:
  - `node --check actions\build.js`
  - `node --check tests\actions.test.js`
  - `npm.cmd run test:actions`
  - `npm.cmd run test:identity`
  - `npm.cmd run test:construction-runs`
  - `npm.cmd run test:building`
  - `npm.cmd run test:blueprint-ir`
  - `npm.cmd run test:construction-compiler`
  - `npm.cmd run test:world-diff`
  - `git diff --check` passed with CRLF warnings only.
- Real bounded retry report:
  - `.tmp/bounded-step-retry-lantern-2026-06-28T13-14-46-886Z.json`
  - ONLINE-GATE passed for `LinXia`.
  - Target step `step_933a5a722ad5f787` at `(610,70,-53)` was retried only within the active run.
  - Before retry: target was `dirt`; top support `(610,71,-53)` was `spruce_log`; below `(610,69,-53)` was `air`.
  - Result: target after retry was `lantern` with `hanging=true` and `waterlogged=false`.
  - The dirt obstruction was recorded as low-risk terrain obstruction and cleared; no structural block was removed.
  - Run after retry stayed `ACTIVE`.
  - Counts after retry: `verified=730 pending=486 repair=6 state_repair=19 retryable_failed=0 cleanup=21 failed=0`.
- Controlled continuation after the lantern retry did not place any additional blocks:
  - `.tmp/auto-reconnect-target-mode-2026-06-28T13-15-32-141Z.json`
  - ONLINE-GATE passed for `LinXia`.
  - Physical build start stopped with `build_start_failed:entity_obstruction:action:609,73,-61:610,73,-62`.
- Read-only entity probe:
  - `.tmp/entity-obstruction-probe-2026-06-28T13-16-47-872Z.json`
  - Player entity `action` was near the blocked work cells at position approximately `(609.8848,73,-60.9476)`.
  - Site-plan obstruction cells reported:
    - `(610,73,-62)`
    - `(610,73,-61)`
  - Current blocker is an external/player entity obstruction, not a hanging-lantern placement regression.
- Fresh continuation probe:
  - `.tmp/entity-obstruction-probe-2026-06-28T13-20-16-920Z.json`
  - ONLINE-GATE again passed for `LinXia` on port `55984`.
  - Target block `(610,73,-62)` was `air`, but player entity `action` was still at approximately `(609.8848,73,-60.9476)`.
  - Site-plan obstruction reasons remained:
    - `entity_obstruction:action:609,73,-61:610,73,-62`
    - `entity_obstruction:action:609,73,-61:610,73,-61`
  - No physical resume was attempted from this state because the same external player entity still blocks the work cells.
- Repeated blocker audit probe:
  - `.tmp/entity-obstruction-probe-2026-06-28T13-22-45-206Z.json`
  - ONLINE-GATE again passed for `LinXia` on port `55984`.
  - Player entity `action` remained at approximately `(609.8848,73,-60.9476)`.
  - Site-plan obstruction reasons were unchanged:
    - `entity_obstruction:action:609,73,-61:610,73,-62`
    - `entity_obstruction:action:609,73,-61:610,73,-61`
  - This is the same external player obstruction across consecutive goal continuations; physical resume remains unsafe until the player entity is moved/despawned.
- Resume attempt after user "continue" at `2026-06-28T23:57:03+08:00`:
  - Required startup files were re-read before acting.
  - Active run was still `construction_run_c57fec1bd503f07e`, `ACTIVE`, phase `frame`, with unchanged placement/hash/bounds.
  - Counts were still `verified=730 pending=486 repair=6 state_repair=19 cleanup=21`.
  - Next step was still `step_a0b2c4a73f132c14`, target `(609,66,-63)`, `grass_block`, status `repair`.
  - Read-only live probe `node .tmp\entity-obstruction-probe.js` failed before writing a probe report because `findMinecraftPort()` could not detect an open Minecraft LAN/server.
  - Process diagnosis did not show active `node` or `java` processes in the returned output.
  - No physical resume was attempted. Current blocker for this attempt is ONLINE-GATE/server unavailable, not a ConstructionRun or WorldDiff result.
- Resume attempt after user "continue" at `2026-06-28T23:59:56+08:00`:
  - Required startup files were re-read before acting.
  - Active run was still `construction_run_c57fec1bd503f07e`, `ACTIVE`, phase `frame`, with unchanged placement/hash/bounds.
  - Counts were still `verified=730 pending=486 repair=6 state_repair=19 cleanup=21`.
  - Read-only live probe succeeded: `.tmp/entity-obstruction-probe-2026-06-28T15-59-27-794Z.json`.
  - ONLINE-GATE passed for `LinXia`; Minecraft LAN/server was detected on port `56168`.
  - Player entity `action` remained at approximately `(609.8848,73,-60.9476)`.
  - Site-plan obstruction reasons remained:
    - `entity_obstruction:action:609,73,-61:610,73,-62`
    - `entity_obstruction:action:609,73,-61:610,73,-61`
  - No physical resume was attempted because the same player entity still occupies protected work cells.
- Current active-run next step after the verified lantern retry:
  - `step_a0b2c4a73f132c14`
  - phase `frame`
  - status `repair`
  - target `(609,66,-63)`
  - block `grass_block`

### Next-Step Recommendation

- Move/despawn the `action` player entity from the blocked build cells near `(610,73,-62)` and `(610,73,-61)`, then resume the same active run with controlled target mode.
- Do not start a fresh build, create a new construction run, force rebuild, or clear the site.

## Current Status - Spruce Log Placement Fix 2026-06-28

- Task: `BUILDING-FIX-SPRUCE-LOG-UNSTABLE-AIR-RESUME`.
- Active runId remains `construction_run_c57fec1bd503f07e`.
- Focused blocker under diagnosis: `step_1b672c3897a09e97`, target `617,70,-59`, `spruce_log` with `axis=z`.
- Read-only probe: `.tmp/spruce-log-unstable-readonly-probe-2026-06-28T10-12-15-621Z.json`.
- Probe evidence:
  - target block before retry: `air`.
  - support below `617,69,-59`: `air`.
  - selected stateful reference from logs: north block `617,70,-60`, `spruce_log`, `axis=y`, face vector `{x:0,y:0,z:1}`, placement axis `z`.
  - west block `616,70,-59` was `spruce_planks` and reachable, but its face vector would place `axis=x`, so it was not a legal `axis=z` stateful reference.
  - north reference was real/stable but not reachable from the bot position; probe eye-to-reference-center distance was about `6.126`, outside the current reachable threshold (`4.5 + 1.1`).
  - bot position during probe: `612.5,67,-56.500295781664704`; yaw `5.176043728270831`, pitch `0.32345166690302474`.
  - dependencies for the step: `[]`.
  - exact last placement log line sequence included `[BUILD_STATEFUL_PLACE] target=617,70,-59 block=spruce_log state=axis_z reference=617,70,-60` followed by retries with `reason=place_failed:unstable_air`.
- Root cause classification:
  - Primary: placement stance/reach. The high-target shortcut accepted the current position because an arbitrary reachable reference existed, but the later stateful axis filter selected a different, unreachable `axis=z` reference.
  - Secondary: pathing/reference selection coupling. The movement decision did not use the same stateful reference set as placement.
  - Not supported by evidence: selected reference was air, dependency incomplete, or target already occupied.
- Source fix:
  - `actions/build.js` now narrows high-target current-reference reach checks through the same stateful placement profile used by placement.
  - `tryPlaceStatefulBlock()` re-reads the live reference block before placement and rejects air/non-reference blocks.
  - Stateful placement now ensures the selected reference is reachable; if not, it finds and moves to a placement stand that can reach that reference before calling Mineflayer.
  - State confirmation remains required for axis blocks, so a successful `spruce_log` placement must match `axis=z`.
- Tests added/updated:
  - `tests/actions.test.js`: horizontal `axis=z` log must move before using the correct north/south reference and must validate state.
  - `tests/actions.test.js`: horizontal log without a legal z-axis reference returns `stateful_axis_no_z_reference` and does not place against air.
  - `tests/construction-run-store.test.js`: bounded retry guard rejects unlisted step ids without placing blocks, changing the run id, or creating a new run.
- Real bounded retry:
  - Helper: `.tmp/bounded-step-retry-spruce-log.js`.
  - Report: `.tmp/bounded-step-retry-spruce-log-2026-06-28T10-18-44-226Z.json`.
  - Safety decision: `resumeOrFresh=resume`, `activeCompatibleRunId=construction_run_c57fec1bd503f07e`, `forceFresh=false`, no new run id appeared.
  - The helper did not attempt the spruce-log placement because resume reconciliation changed the next executable step to `step_6c3642b01358f900` (`clear_block`, target `609,66,-63`).
  - This was treated as a bounded guard/blocker, not bypassed. `step_1b672c3897a09e97` moved from `retryable_failed` to `pending` during reconciliation and remains unverified.
- Current persisted run state after that bounded helper:
  - `status=ACTIVE`
  - `verified=622`, `repair=10`, `pending=590`, `state_repair=16`, `cleanup=21`
  - `retryable_failed=0`
  - next executable blocker for a strict single-step retry is `step_6c3642b01358f900`, a clear step outside the requested allowed step id.
- Do not force-place `step_1b672c3897a09e97` out of schedule. The next physical resume must either handle the earlier scheduled clear step under its own bounded guard or explicitly re-run a broader controlled resume window.

## Previous Status - Leaf Override Applied, New Placement Stop 2026-06-28

- Latest checked HEAD: `6049ee91fcb8c35ea5b2715de0747583fd4939b2`
- Active runId: `construction_run_c57fec1bd503f07e`
- Blueprint hash: `bbb81941d7859fd9ed6ff11fd3bad4cab60168ac`
- Placement: origin `605,66,-64`, rotationY `0`, mirror `false/false`
- Bounds: `x=605..618`, `y=66..86`, `z=-64..-53`
- Identity: LinXia verified by bounded helper ONLINE-GATE during the latest real run.
- Latest physical report: `.tmp/bounded-physical-resume-2026-06-28T09-53-06-245Z.json`
- Safety in latest real run: `resumeOrFresh=resume`, `activeCompatibleRunId=construction_run_c57fec1bd503f07e`, `freshBuildAttempted=false`, `newRunCreated=false`, and the same run remained active.
- Current persisted run state after latest physical stop:
  - `status=ACTIVE`
  - `blockedReason=null`
  - `currentPhase=frame`
  - `terminalState=null`
  - `verified=641`, `repair=2`, `pending=577`, `state_repair=16`, `retryable_failed=1`, `cleanup=21`
- User-approved decorative leaf substitution:
  - The user approved `azalea_leaves -> oak_leaves` only for decorative/foliage/exterior/detail use, not structure/support/functional/redstone.
  - `.tmp/apply-azalea-leaf-override.js` applied a current-run-only override to `step_a788115b4c4701c0`.
  - Recorded reason: `USER_APPROVED_DECORATIVE_LEAF_SUBSTITUTION`.
  - Recorded fields include `originalBlock=azalea_leaves`, `resolvedBlock=oak_leaves`, `userApproved=true`, `scope=currentRun`, `affectsWorldDiff=true`, `sourceStepIds=["step_a788115b4c4701c0"]`.
  - Classification evidence: block id ended in `_leaves`, role was `null`, dependencies count was `0`, source block `clearancePolicy=clear_replaceable`, and no structural/support/functional/redstone role was present.
  - Recompute report `.tmp/material-accounting-after-leaf-override-items-2026-06-28T09-52-42-132Z.json` showed current-phase `shortageOriginal=[azalea_leaves:1]`, `shortageResolved=[]`, `proceed=true`.
  - Logs confirm `[MATERIAL_RESOLUTION] {"originalBlock":"azalea_leaves","resolvedBlock":"oak_leaves","reason":"USER_APPROVED_DECORATIVE_LEAF_SUBSTITUTION",...}`.
  - The target leaf step is now `verified` with `block.id=oak_leaves`, `originalBlock.id=azalea_leaves`, `resolvedBlock.id=oak_leaves`.
- Latest physical progress:
  - Started from `verified=625`, `pending=588`, `repair=8`, `state_repair=16`, `cleanup=21`.
  - Executed `stepsExecuted=16`.
  - Ended at `verified=641`, `pending=577`, `repair=2`, `state_repair=16`, `retryable_failed=1`, `cleanup=21`.
  - Staging withdrawal succeeded for `oak_leaves` from chest `589,69,-55`; visible chest count changed from `oak_leaves=27` to `oak_leaves=26`.
  - No fresh run was created and the active run id did not change.
- Current blocker / stop condition:
  - Bounded resume stopped with `place_failed:unstable_air`.
  - Failing step: `step_1b672c3897a09e97`, source block `b00499_12,4,5`.
  - Target: `617,70,-59`.
  - Block: `spruce_log` with state `axis=z`.
  - Role: `column`.
  - Phase: `frame`.
  - Retry state: `count=2`, `lastError=place_failed:unstable_air`, `lastAt=2026-06-28T09:57:08.416Z`.
  - Logs show repeated `[BUILD_PLACE_RETRY] target=617,70,-59 block=spruce_log attempt=2/3/4 reason=place_failed:unstable_air`.
  - Treat this as `placement/support/movement` until a focused diagnosis proves otherwise.
- Current state-sensitive placement work:
  - `actions/build.js` now has stateful placement paths for top slabs, bottom slabs, double slabs, wall buttons, and axis blocks.
  - Real logs confirmed top slab placement, double slab merge placement (`slab_double_first` then `slab_double_merge` at `608,70,-54`), and axis log placement for multiple axes.
  - `systems/building-system.js` now passes `requireStateConfirmation` for steps with expected block states, so wrong slab/log/button states are not silently counted as success.
  - `systems/building-system.js` also ignores non-comparable dynamic states such as leaf `distance`, `waterlogged`, and connection states for fences/walls/panes/bars.
- Remaining risk / next step:
  - Do not run another bounded physical resume until the `spruce_log axis=z` unstable-air placement failure is diagnosed or explicitly accepted as safe to retry.
  - `state_repair=16` remains and includes slabs, logs, a wall button, and a `white_candle` requiring `candles=3`.
  - The candle stack state has not yet been implemented or physically verified.
  - Other later-phase/decorative material shortages still exist in full material planning, but they are not the current frame gate after the run-scoped leaf override.
- Tests run after this checkpoint:
  - `node --check systems\material-resolution.js`
  - `node --check systems\building-system.js`
  - `node --check tests\construction-run-store.test.js`
  - `node --check .tmp\apply-azalea-leaf-override.js`
  - `npm.cmd run test:identity`
  - `npm.cmd run test:construction-runs`
  - `npm.cmd run test:building`
  - `npm.cmd run test:blueprint-ir`
  - `npm.cmd run test:construction-compiler`
  - `npm.cmd run test:world-diff`
  - `git diff --check`
- Earlier tests still relevant from prior checkpoint:
  - `node --check actions\build.js`
  - `node --check tests\actions.test.js`
  - `node --check .tmp\bounded-physical-resume.js`
  - `npm.cmd run test:actions`
- Do not run full building acceptance yet. The active run is incomplete and stopped on a real placement failure.

## Superseded Historical Status - Material Shortage Stop 2026-06-28

The azalea leaf shortage is kept as historical context in earlier reports. It was resolved by the user-approved current-run substitution above and the target step is now verified as `oak_leaves`.

## Superseded Historical Status - Accelerated Controlled Resume 2026-06-28

The older dirt-path blocker details below are kept as history. They are superseded by later successful bounded physical reports showing dirt-path progress and the latest `azalea_leaves` dynamic-state material blocker above.

- Latest checked HEAD: `6049ee91fcb8c35ea5b2715de0747583fd4939b2`
- Active runId: `construction_run_c57fec1bd503f07e`
- Blueprint hash: `bbb81941d7859fd9ed6ff11fd3bad4cab60168ac`
- Placement: origin `605,66,-64`, rotationY `0`, mirror `false/false`
- Bounds: `x=605..618`, `y=66..86`, `z=-64..-53`
- Identity: LinXia / 林夏 verified by bounded helper ONLINE-GATE during the latest real run.
- Latest physical report: `.tmp/bounded-physical-resume-2026-06-28T03-57-49-069Z.json`
- Safety in latest real run: `resumeOrFresh=resume`, `activeCompatibleRunId=construction_run_c57fec1bd503f07e`, `freshBuildAttempted=false`, `newRunCreated=false`, `forceFresh=false`, `clearedArea=false`.
- Accelerated batch result:
  - Requested window: `BOUNDED_MAX_STEPS=100`
  - Started from `verified=181`, `pending=981`, `cleanup=21`
  - Stopped at `verified=204`, `retryable_failed=1`, `pending=957`, `cleanup=21`
  - `stepsExecuted=23`, elapsed about 3.75 minutes from report timestamp to completion, roughly 6.1 verified steps/minute.
- Physical progress in the accelerated batch:
  - Placed scaffold column `608,77..86,-65`.
  - Placed frame/base blocks at `606,66,-62`, `607,66,-61`, `608,66,-61`, `607,66,-60`, `609,66,-61`, `610,66,-63`, `607,66,-59`, `610,66,-62`, `610,66,-61`, `606,66,-58`, `607,66,-58`, `608,66,-58`, `611,66,-61`.
  - Restored and verified the previously stale-cleared stone placement at `608,66,-58`.
  - The earlier stale-cleared terrain target `607,66,-53` is still `pending` as dirt and has not yet been restored.
- Current persisted run state:
  - `status=ACTIVE`
  - `currentPhase=frame`
  - `terminalState=null`
  - `verified=204`, `retryable_failed=1`, `pending=957`, `cleanup=21`
- Current blocker / stop condition:
  - Step `step_3bbd53d3fcb90bdd`, source block `b00084_7,0,0`, target `612,66,-64`, block `dirt_path`, phase `frame`, is `retryable_failed`.
  - Retry state: `count=2`, `lastError=place_failed:unstable_air`, `lastAt=2026-06-28T04:01:33.828Z`.
  - Logs show repeated `[BUILD_DIRT_PATH_BASE_RETRY] target=612,66,-64 ... reason=place_failed:unstable_air`.
  - The target ended as `dirt`, not `dirt_path`, so API-level attempts did not produce the required final block.
  - Per accelerated mode rules, do not continue physical construction until this dirt-path placement/root cause is handled or the user explicitly authorizes the next action.
- Throughput diagnosis:
  - The prior low throughput was dominated by bounded-helper startup/preparation overhead: each small run redid blueprint preview, ConstructionRun preparation, full material planning, and four staging chest scans before executing only 1 to 5 steps.
  - With a larger batch, actual frame/scaffold placement throughput improved substantially until the dirt-path blocker.
  - Staging chest scans are still repeated at batch start and again before frame placement; future speed work should avoid reopening all staging chests for every bounded process when no source/material state changed.
- Tests run after this checkpoint:
  - `npm.cmd run test:identity`
  - `npm.cmd run test:construction-runs`
  - `git diff --check`
- Do not run full building acceptance yet. The active run is incomplete and blocked on the dirt-path frame step.

## Completed Or Mostly Implemented

- `systems/blueprint-ir.js`: BlueprintIR conversion and validation path.
- `systems/construction-compiler.js`: deterministic construction plan with stable step ids based on blueprint revision/hash, placement, source block key, and action.
- `systems/building-system.js`: orchestration for design, preview, material planning, phased placement, validation, repair hooks, staging chest handling, ConstructionRun preparation, and completion archive.
- `systems/construction-run-store.js`: persisted ConstructionRun store with atomic tmp-file write/rename, active-run lookup, compatibility checks, step updates, and terminal states.
- `systems/building-design-spec.js`: DesignSpec, blueprint freeze, lifecycle phase order, and archive helpers.
- `systems/world-diff-result.js`: structured world-diff result handling.
- `systems/index.js`: exports building-related systems including ConstructionRunStore.
- `tests/construction-run-store.test.js`: broad unit coverage for resume, reconciliation, staging chest, phase gates, blueprint revision mismatch, two restarts, completion terminal state, and lifecycle archive.
- `tests/blueprint-building.test.js`, `tests/blueprint-ir.test.js`, `tests/construction-compiler.test.js`, and `tests/world-diff-result.test.js`: existing building/IR/compiler/diff unit coverage.

## Real Latest Acceptance State

Confirmed from `acceptance/reports/latest-summary.md`:

```text
projectName: minecraft
result: 0 PASS / 1 FAIL / 0 BLOCKED / 0 ERROR
finishedAt: 2026-06-27T10:01:38.331Z
case: building / case1 P9R faithful community two-story wood house import
judgment: FAIL
reason: build_task_failed:place_failed:unstable_air
recommendedTeleportCommand: /tp LinXia accept_tester
```

Confirmed from `logs/bot-current.log`:

- The failing build task reached a dirt path placement path.
- Latest task failure reason was `place_failed:unstable_air`.
- The fresh run after the default identity fix used `LinXia`, confirmed by `DEBUG_STATUS` and the latest report's recommended teleport command.
- Logs show repeated `[BUILD_DIRT_PATH_BASE_RETRY] target=612,66,-64 ... reason=place_failed:unstable_air` before task failure.

Do not report building as PASS until a new latest acceptance report proves it.

## P0 Incident Notes

Incident task: `INCIDENT-BUILDING-REGRESSION-IDENTITY-RESUME`

Confirmed identity root cause:

- Before the identity fix, `bot.js` defaulted to `process.env.PERSONA || 'andy'`.
- A restart without `PERSONA=linxia` therefore loaded `personas/andy.js` and joined as `Andy`.
- Current source default is `linxia`, and `tests/default-persona.test.js` pins `林夏 / LinXia`.

Confirmed resume regression risk:

- Latest acceptance logs show the build task ran with `forceRebuild:true` and `rebuildReason:"explicit_rebuild_requested"`.
- `BuildingSystem.resumeOriginForSelectedBlueprint()` intentionally ignored active-run origin when `forceRebuild` was true.
- `BuildingSystem.prepareConstructionRun()` would abandon an active run on force rebuild.
- This explains how a restart or rerun can behave like a fresh foundation build instead of resume, especially when acceptance or parser marks a command as rebuild.

New protection added after the incident:

- `BuildingSystem` now emits `[BUILDING_RUN_DECISION]` before construction starts.
- If a fresh/rebuild path is about to start and target bounds already contain enough existing structure blocks, it returns `EXISTING_STRUCTURE_DETECTED_NEEDS_RECONCILIATION`.
- This protection also applies to `forceRebuild:true` unless the caller explicitly passes `allowOverwriteExistingStructure:true`.
- `rescueExistingBuild()` provides read-only `RESCUE_EXISTING_BUILD` analysis: it scans the planned bounds and reports target-block counts (`verifiedBlocks`, `missingBlocks`, `wrongBlocks`, `wrongStates`, `extraBlocks`) plus construction-step reconciliation counts (`verifiedSteps`, `pendingSteps`, `repairSteps`, `stateRepairSteps`, `cleanupSteps`), `likelyCurrentPhase`, `canResume`, and a reason. It does not place or clear blocks.
- `[BUILDING_RUN_DECISION]` keeps legacy `verifiedSteps` / `pendingSteps` fields for compatibility and also emits explicit aliases: `verifiedTargetBlocks`, `missingTargetBlocks`, `wrongTargetBlocks`, `wrongStateTargetBlocks`, `extraNonBlueprintBlocks`, `verifiedConstructionSteps`, and `pendingConstructionSteps`.
- Reconciliation now normalizes runtime steps that use `target/block` as well as legacy `position/blockName`, reducing the risk that world-scanned progress is missed after compiler shape changes.

## Uncommitted Change Classification

Completed but uncommitted:

- BlueprintIR / compiler / WorldDiff / BuildingSystem orchestration changes already present in the worktree.
- DesignSpec and construction lifecycle support in `systems/building-design-spec.js`.
- ConstructionRun persistence and resume tests in `systems/construction-run-store.js` and `tests/construction-run-store.test.js`.
- Default persona correction to LinXia in `bot.js`, `tests/default-persona.test.js`, and `package.json`.
- Documentation runbooks in this file and `docs/CODEX_BOT_STARTUP.md`.

Currently in progress:

- Dirt-path placement recovery in `actions/build.js` and `tests/actions.test.js`. Unit tests for the new retry behavior were passing, but real Minecraft acceptance moved to the next failure: `place_failed:unstable_air` while placing/activating dirt path support. Treat this as placement/support/movement work still open.
- Full Minecraft building acceptance is not green.

Generated/runtime dirty:

- `acceptance/reports/latest-report.json`
- `acceptance/reports/latest-report.md`
- `acceptance/reports/latest-summary.md`
- `acceptance/reports/building-case1-...`
- `data/memory/task-memory.json`
- `data/memory/world-memory.json`
- `data/memory/construction-runs.json` and tmp files
- `.tmp/`
- `data/community-builds/cache/`

Unrelated or not-yet-attributed dirty:

- Storage, survival, farming, intent, and some acceptance/test files are dirty in the worktree. Do not revert them unless the user explicitly asks and current diffs prove they are safe to touch.

## RESUMABLE-CONSTRUCTION

- implemented: partial

Current behavior:

- ConstructionRun persistence exists and stores `runId`, blueprint id/revision/hash, `planId`, placement context, world identity, bounds, staging chests, phase, per-step status, retry info, created/updated timestamps, and terminal state.
- Step ids are deterministic in `systems/construction-compiler.js`.
- `BuildingSystem.prepareConstructionRun()` checks compatible active runs before creating a new one.
- Incompatible active runs are abandoned with a logged reason, including blueprint hash or placement/world mismatch.
- Resume reconciliation scans real world state through `context.bot.blockAt()`:
  - correct target block/state -> `verified`
  - missing target -> `pending`
  - wrong block -> `repair`
  - wrong state/orientation -> `state_repair`
  - scaffold remove still occupied -> `cleanup`
- Verified steps are treated as satisfied dependencies, and execution resumes from the earliest unresolved phase/step rather than blindly using an array index.
- Staging chest records persist and are reused; resume inventory reconciliation reads physical staging inventory when a storage reader is available.
- Completed runs are marked `COMPLETED` and are not active.

Evidence:

- `tests/construction-run-store.test.js` contains tests for:
  - partial resume without replaying verified blocks
  - placed-but-unverified recovery through world scan
  - verified checkpoint with missing block returning to pending
  - wrong orientation entering `state_repair`
  - staging inventory restoration and shortage blocking
  - blueprint revision mismatch refusing wrong resume
  - same run converging across two restarts
  - completed run not active
- `acceptance/cases/building.acceptance.js` marks the fixture mode as `FRESH_FIXTURE_BUILD`, so reset-world acceptance should not be mistaken for failed resume semantics.

Missing pieces:

- Real Minecraft acceptance has not proven resume behavior end to end.
- Staging chest flow is partly mocked in unit tests; full physical chest placement, transfer, reopen, and cleanup need real-server verification.
- Severe-damage repair cost threshold is not proven by latest acceptance evidence.
- Final habitability gates and two distinct real buildings are unit-covered at a narrow level, but not proven by real Minecraft acceptance.

Next task:

```text
BUILDING-REAL-ACCEPTANCE-DIRTPATH-UNSTABLE-AIR
```

Fix only the current root cause first: dirt path support/base placement can fail with `place_failed:unstable_air` in real Minecraft. Classify the fix under `placement/support/movement`, add a focused unit test, rerun the targeted building tests, restart LinXia, and rerun one building acceptance case.

## Next Goal-Mode Rules

- Do not add broad architecture unless the current evidence demands it.
- Prefer one root cause per round.
- Classify failures as one of: `blueprint`, `compiler`, `executor`, `movement`, `support`, `placement`, `material`, `validation`, `habitability`, `world fixture`.
- If tests pass and real Minecraft acceptance progresses, make a checkpoint commit with explicit file staging only.
- Never clear the build site and rebuild silently to fake resume.
- Never mark generated reports as PASS by hand.
- Never treat `FRESH_FIXTURE_BUILD` as a resume test.
