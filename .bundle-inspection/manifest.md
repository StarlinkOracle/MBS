# CRM bundle manifest

Generated: 2026-08-09T21:46:18Z

## Top-level entries
.gitignore
MBS-System-Assessment-and-Roadmap.pdf
README.md
apps
apps/agent
apps/api
apps/mobile_flutter
apps/web
apps/worker
archives
backups
backups/backup.log
backups/load-smoke-history.jsonl
backups/load-smoke.log
backups/load-smoke.marker
docker-compose.yml
docs
docs/AGENT_MVP_V1.md
docs/AGENT_PLAYBOOKS.md
docs/AUTONOMY.md
docs/CLAUDE_TASK_PROMPT_LIBRARY.md
docs/CLAUDE_TOOL_AUTHORING_PACK.md
docs/CLAUDE_TOOL_WORKED_EXAMPLES.md
docs/GOVERNANCE.md
docs/INSTALL_PRICING_ENGINE.md
docs/INTEGRATIONS.md
docs/LEAD_CARE.md
docs/LEGAL_PACKS.md
docs/LEGAL_PACKS_IMPORT.md
docs/MOBILE_OFFLINE_V1.md
docs/OPERATIONS_HARDENING.md
docs/PHASE2_GEO_INTELLIGENCE.md
docs/PILOT_DISPATCH_MEDIA.md
docs/REPO_AUTHORITY_AUDIT.md
docs/SERVICE_PRICING_V1.md
package-lock.json
package.json
packages
packages/agent-graph
packages/agent-playbooks
packages/auth
packages/connectors
packages/db
packages/equipment-decoder
packages/event-bus
packages/geocode
packages/shared
packages/storage
packages/tool-registry
scripts
scripts/generate-external-pack-manifest.mjs
scripts/import-legal-pack.ts
scripts/ops
scripts/verify-external-pack-manifest.mjs
tsconfig.base.json
types
types/bcryptjs
website
website/.gitignore
website/README.md
website/attached_assets
website/client
website/components.json
website/drizzle.config.ts
website/package-lock.json
website/package.json
website/postcss.config.js
website/server
website/shared
website/tailwind.config.ts
website/tsconfig.json
website/vite.config.ts

## Full file list
.gitignore	102 bytes
MBS-System-Assessment-and-Roadmap.pdf	263597 bytes
README.md	6367 bytes
apps/agent/Dockerfile	312 bytes
apps/agent/package.json	437 bytes
apps/agent/src/comms-agent.ts	9551 bytes
apps/agent/src/index.ts	1010 bytes
apps/agent/src/master-agent.ts	9346 bytes
apps/agent/src/model-provider.ts	1759 bytes
apps/agent/src/skill-graph.ts	4602 bytes
apps/agent/tests/skill-graph.spec.ts	659 bytes
apps/agent/tsconfig.json	150 bytes
apps/api/Dockerfile	322 bytes
apps/api/package.json	915 bytes
apps/api/src/agent-playbooks.ts	10355 bytes
apps/api/src/approval-flow.ts	627 bytes
apps/api/src/async-timeout.ts	915 bytes
apps/api/src/index.ts	457838 bytes
apps/api/src/legal-pack-importer.ts	36097 bytes
apps/api/src/media-processing.ts	2406 bytes
apps/api/src/playbook-execution-guard.ts	3928 bytes
apps/api/src/playbook-governance-gate.ts	4038 bytes
apps/api/src/stream-cursor.ts	2963 bytes
apps/api/src/stream-guards.ts	6346 bytes
apps/api/src/types/heic-convert.d.ts	232 bytes
apps/api/tests/agent-playbook-endpoint.spec.ts	28511 bytes
apps/api/tests/agent-playbooks.spec.ts	14335 bytes
apps/api/tests/approval-flow.spec.ts	1109 bytes
apps/api/tests/async-timeout.spec.ts	873 bytes
apps/api/tests/call-webhook.spec.ts	4127 bytes
apps/api/tests/external-pack-fixtures.spec.ts	3212 bytes
apps/api/tests/fixtures/EXTERNAL_PACKS_MANIFEST.json	7578 bytes
apps/api/tests/fixtures/agent-playbooks/mbs_agent_v1/playbooks/admin_template_publish.json	228 bytes
apps/api/tests/fixtures/agent-playbooks/mbs_agent_v1/playbooks/contract_redline_review_v1.json	225 bytes
apps/api/tests/fixtures/agent-playbooks/mbs_agent_v1/schema/playbook.schema.json	679 bytes
apps/api/tests/fixtures/agent-playbooks/mbs_agent_v1/schema/results.schema.json	252 bytes
apps/api/tests/fixtures/agent-playbooks/mbs_agent_v1/schema/skill.schema.json	1448 bytes
apps/api/tests/fixtures/agent-playbooks/mbs_agent_v1/schema/tools_catalog.schema.json	635 bytes
apps/api/tests/fixtures/agent-playbooks/mbs_agent_v1/skills/contract_redline_skill_v1.json	853 bytes
apps/api/tests/fixtures/agent-playbooks/mbs_agent_v1/tools_catalog.json	305 bytes
apps/api/tests/fixtures/agent-playbooks/mbs_agent_v1_1/playbook.schema.json	678 bytes
apps/api/tests/fixtures/agent-playbooks/mbs_agent_v1_1/playbooks/admin_template_publish.json	261 bytes
apps/api/tests/fixtures/agent-playbooks/mbs_agent_v1_1/playbooks/contract_redline_review_v1_1.json	353 bytes
apps/api/tests/fixtures/agent-playbooks/mbs_agent_v1_1/skill.schema.json	1200 bytes
apps/api/tests/fixtures/agent-playbooks/mbs_agent_v1_1/skills/admin_template_publish_stub_skill_v1_1.json	296 bytes
apps/api/tests/fixtures/agent-playbooks/mbs_agent_v1_1/skills/contract_redline_finalize_skill_v1_1.json	317 bytes
apps/api/tests/fixtures/agent-playbooks/mbs_agent_v1_1/skills/contract_redline_generate_skill_v1_1.json	356 bytes
apps/api/tests/fixtures/agent-playbooks/mbs_agent_v1_1/tools_catalog.json	380 bytes
apps/api/tests/fixtures/agent-playbooks/mbs_agent_v1_1/tools_catalog.schema.json	699 bytes
apps/api/tests/fixtures/legal-packs/CO/v1/clauses.json	626 bytes
apps/api/tests/fixtures/legal-packs/CO/v1/legal_pack.json	279 bytes
apps/api/tests/fixtures/legal-packs/CO/v1/placeholder_whitelist.json	69 bytes
apps/api/tests/fixtures/legal-packs/CO/v1/schema/clauses.schema.json	687 bytes
apps/api/tests/fixtures/legal-packs/CO/v1/schema/legal_pack.schema.json	504 bytes
apps/api/tests/fixtures/legal-packs/CO/v1/schema/templates.schema.json	777 bytes
apps/api/tests/fixtures/legal-packs/CO/v1/schema/variable_schemas.schema.json	392 bytes
apps/api/tests/fixtures/legal-packs/CO/v1/templates.json	742 bytes
apps/api/tests/fixtures/legal-packs/CO/v1/variable_schemas.json	567 bytes
apps/api/tests/intake.spec.ts	8588 bytes
apps/api/tests/json-body-guards.spec.ts	1770 bytes
apps/api/tests/lead-care.spec.ts	6155 bytes
apps/api/tests/legal-pack-importer.spec.ts	29861 bytes
apps/api/tests/media-processing.spec.ts	2220 bytes
apps/api/tests/media-upload-session.spec.ts	4823 bytes
apps/api/tests/mobile-pin-auth.spec.ts	18183 bytes
apps/api/tests/mobile-sync.spec.ts	56835 bytes
apps/api/tests/playbook-execution-guard.spec.ts	4065 bytes
apps/api/tests/playbook-governance-gate.spec.ts	2662 bytes
apps/api/tests/public-quote-media.spec.ts	6461 bytes
apps/api/tests/stream-cursor.spec.ts	3342 bytes
apps/api/tests/stream-endpoint.spec.ts	4246 bytes
apps/api/tests/stream-guards.spec.ts	4832 bytes
apps/api/tests/system-health.spec.ts	98934 bytes
apps/api/tsconfig.json	150 bytes
apps/mobile_flutter/.gitignore	174 bytes
apps/mobile_flutter/analysis_options.yaml	121 bytes
apps/mobile_flutter/lib/core/api/mobile_api_client.dart	5903 bytes
apps/mobile_flutter/lib/core/auth/auth_controller.dart	7191 bytes
apps/mobile_flutter/lib/core/db/local_database.dart	11611 bytes
apps/mobile_flutter/lib/core/models/mobile_sync_models.dart	2118 bytes
apps/mobile_flutter/lib/core/rbac/rbac.dart	928 bytes
apps/mobile_flutter/lib/core/sync/sync_engine.dart	9488 bytes
apps/mobile_flutter/lib/core/sync/sync_logic.dart	1887 bytes
apps/mobile_flutter/lib/features/auth/login_screen.dart	4933 bytes
apps/mobile_flutter/lib/features/dispatch/dispatch_screen.dart	13496 bytes
apps/mobile_flutter/lib/features/home/home_shell.dart	10142 bytes
apps/mobile_flutter/lib/features/jobs/job_detail_screen.dart	5403 bytes
apps/mobile_flutter/lib/features/media/photo_upload_service.dart	1065 bytes
apps/mobile_flutter/lib/features/tech/today_screen.dart	3249 bytes
apps/mobile_flutter/lib/features/timeclock/time_clock_screen.dart	7667 bytes
apps/mobile_flutter/lib/main.dart	4602 bytes
apps/mobile_flutter/pubspec.yaml	765 bytes
apps/mobile_flutter/test/auth_controller_test.dart	2343 bytes
apps/mobile_flutter/test/sync_engine_test.dart	6201 bytes
apps/mobile_flutter/test/sync_logic_test.dart	2183 bytes
apps/web/Dockerfile	326 bytes
apps/web/index.html	306 bytes
apps/web/package.json	391 bytes
apps/web/scripts/smoke-check.mjs	1548 bytes
apps/web/src/App.jsx	21760 bytes
apps/web/src/components/AgentRunStatusPanel.jsx	15069 bytes
apps/web/src/components/CommandPalette.jsx	30803 bytes
apps/web/src/components/ExecutionWhyPanel.jsx	5973 bytes
apps/web/src/context/AuthContext.jsx	4324 bytes
apps/web/src/data/demoData.js	3212 bytes
apps/web/src/hooks/useDebouncedValue.js	355 bytes
apps/web/src/hooks/useEventStream.js	2866 bytes
apps/web/src/hooks/useQuery.js	2669 bytes
apps/web/src/lib/apiClient.js	3579 bytes
apps/web/src/main.jsx	308 bytes
apps/web/src/pages/AccountingExpensesPage.jsx	6366 bytes
apps/web/src/pages/AccountingReceiptsPage.jsx	6781 bytes
apps/web/src/pages/AgentGraphPage.jsx	19794 bytes
apps/web/src/pages/AgentRunsPage.jsx	4166 bytes
apps/web/src/pages/ApprovalsPage.jsx	6317 bytes
apps/web/src/pages/ControlRoomPage.jsx	41688 bytes
apps/web/src/pages/DispatchPage.jsx	17298 bytes
apps/web/src/pages/DraftsPage.jsx	11028 bytes
apps/web/src/pages/EstimatePage.jsx	10486 bytes
apps/web/src/pages/ExecutionsPage.jsx	5942 bytes
apps/web/src/pages/GovernancePage.jsx	9356 bytes
apps/web/src/pages/InboxPage.jsx	14824 bytes
apps/web/src/pages/JobberImportPage.jsx	13301 bytes
apps/web/src/pages/LeadsPage.jsx	49073 bytes
apps/web/src/pages/PipelineBoardPage.jsx	11807 bytes
apps/web/src/pages/SalesPage.jsx	12582 bytes
apps/web/src/pages/ServicePricingAdminPage.jsx	17231 bytes
apps/web/src/pages/ServiceQuoteBuilderPage.jsx	28544 bytes
apps/web/src/pages/SystemAssessmentPage.jsx	65315 bytes
apps/web/src/utils/format.js	866 bytes
apps/web/vite.config.js	334 bytes
apps/worker/Dockerfile	313 bytes
apps/worker/package.json	437 bytes
apps/worker/src/geo-rollup.ts	11999 bytes
apps/worker/src/index.ts	22473 bytes
apps/worker/src/jobber-csv-import.ts	26383 bytes
apps/worker/src/ocr.ts	6500 bytes
apps/worker/src/receipt-ocr.ts	5648 bytes
apps/worker/tests/geo-rollup.spec.ts	5236 bytes
apps/worker/tsconfig.json	150 bytes
backups/backup.log	242 bytes
backups/load-smoke-history.jsonl	888 bytes
backups/load-smoke.log	1911 bytes
backups/load-smoke.marker	182 bytes
docker-compose.yml	2915 bytes
docs/AGENT_MVP_V1.md	3838 bytes
docs/AGENT_PLAYBOOKS.md	8741 bytes
docs/AUTONOMY.md	2709 bytes
docs/CLAUDE_TASK_PROMPT_LIBRARY.md	6700 bytes
docs/CLAUDE_TOOL_AUTHORING_PACK.md	8127 bytes
docs/CLAUDE_TOOL_WORKED_EXAMPLES.md	4091 bytes
docs/GOVERNANCE.md	2381 bytes
docs/INSTALL_PRICING_ENGINE.md	3231 bytes
docs/INTEGRATIONS.md	7415 bytes
docs/LEAD_CARE.md	2513 bytes
docs/LEGAL_PACKS.md	407 bytes
docs/LEGAL_PACKS_IMPORT.md	5039 bytes
docs/MOBILE_OFFLINE_V1.md	10882 bytes
docs/OPERATIONS_HARDENING.md	27155 bytes
docs/PHASE2_GEO_INTELLIGENCE.md	4339 bytes
docs/PILOT_DISPATCH_MEDIA.md	4063 bytes
docs/REPO_AUTHORITY_AUDIT.md	6319 bytes
docs/SERVICE_PRICING_V1.md	2942 bytes
package-lock.json	251182 bytes
package.json	2419 bytes
packages/agent-graph/package.json	270 bytes
packages/agent-graph/src/index.ts	9383 bytes
packages/agent-graph/tsconfig.json	115 bytes
packages/agent-playbooks/__tests__/engine.spec.ts	22518 bytes
packages/agent-playbooks/executor.ts	20655 bytes
packages/agent-playbooks/index.ts	491 bytes
packages/agent-playbooks/loader.ts	5371 bytes
packages/agent-playbooks/package.json	329 bytes
packages/agent-playbooks/tsconfig.json	135 bytes
packages/agent-playbooks/types.ts	3310 bytes
packages/agent-playbooks/validator.ts	5538 bytes
packages/auth/package.json	401 bytes
packages/auth/src/index.ts	36 bytes
packages/auth/tsconfig.json	150 bytes
packages/connectors/package.json	298 bytes
packages/connectors/src/gmail.ts	9768 bytes
packages/connectors/src/imessage.ts	7034 bytes
packages/connectors/src/index.ts	489 bytes
packages/connectors/src/keychain.ts	583 bytes
packages/connectors/src/senders.ts	2033 bytes
packages/connectors/src/types.ts	1424 bytes
packages/connectors/tests/connectors.spec.ts	5041 bytes
packages/connectors/tsconfig.json	132 bytes
packages/db/package.json	726 bytes
packages/db/prisma/migrations/20260218225450_autonomy_v1/migration.sql	20274 bytes
packages/db/prisma/migrations/20260219012829_governance_policy_killswitch_exposure_v1/migration.sql	2579 bytes
packages/db/prisma/migrations/20260219153554_jobber_csv_import_v1/migration.sql	3800 bytes
packages/db/prisma/migrations/20260219174100_jobber_import_tools_domain_v1/migration.sql	1877 bytes
packages/db/prisma/migrations/20260219181614_attribution_calls_v1/migration.sql	4169 bytes
packages/db/prisma/migrations/20260219181944_receipts_expenses_v1/migration.sql	6921 bytes
packages/db/prisma/migrations/20260219194026_phase2_marketing_geo_intelligence_v1/migration.sql	8521 bytes
packages/db/prisma/migrations/20260219235900_marketing_metric_daily_compat/migration.sql	223 bytes
packages/db/prisma/migrations/20260220005706_ui_testing_gate_intake_v1/migration.sql	6848 bytes
packages/db/prisma/migrations/20260220160000_equipment_catalog_spec_decoder_v1/migration.sql	6944 bytes
packages/db/prisma/migrations/20260220161000_equipment_catalog_trgm_v1/migration.sql	310 bytes
packages/db/prisma/migrations/20260221191746_dispatch_media_retention_v1/migration.sql	0 bytes
packages/db/prisma/migrations/20260221191816_dispatch_media_retention_v1/migration.sql	1252 bytes
packages/db/prisma/migrations/20260221193000_install_pricing_engine_v1/migration.sql	3521 bytes
packages/db/prisma/migrations/20260221200000_service_pricing_v1/migration.sql	8070 bytes
packages/db/prisma/migrations/20260222031722_master_agent_mvp_v1/migration.sql	6470 bytes
packages/db/prisma/migrations/20260222153348_mobile_offline_timeclock_v1/migration.sql	6660 bytes
packages/db/prisma/migrations/20260222164500_usable_mbs_quote_job_scheduling_v1/migration.sql	9690 bytes
packages/db/prisma/migrations/20260222175358_mobile_pin_auth_hardening_v1/migration.sql	561 bytes
packages/db/prisma/migrations/20260223000100_media_upload_sessions_v1/migration.sql	1912 bytes
packages/db/prisma/migrations/20260223003000_correlation_id_observability_v1/migration.sql	551 bytes
packages/db/prisma/migrations/20260223170000_legal_pack_importer_v1/migration.sql	3589 bytes
packages/db/prisma/migrations/20260225204000_lead_care_phase1/migration.sql	4179 bytes
packages/db/prisma/migrations/migration_lock.toml	128 bytes
packages/db/prisma/schema.prisma	79685 bytes
packages/db/prisma/seed.ts	138410 bytes
packages/db/src/bcryptjs.d.ts	27 bytes
packages/db/src/index.ts	346 bytes
packages/db/tsconfig.json	150 bytes
packages/equipment-decoder/package.json	258 bytes
packages/equipment-decoder/src/index.ts	6893 bytes
packages/equipment-decoder/tests/index.spec.ts	1344 bytes
packages/equipment-decoder/tsconfig.json	132 bytes
packages/event-bus/package.json	312 bytes
packages/event-bus/src/index.ts	1449 bytes
packages/event-bus/tsconfig.json	150 bytes
packages/geocode/package.json	266 bytes
packages/geocode/src/index.ts	7373 bytes
packages/geocode/tsconfig.json	132 bytes
packages/shared/package.json	265 bytes
packages/shared/src/index.ts	958 bytes
packages/shared/src/mobile-sync-contract.ts	1008 bytes
packages/shared/src/pricing.ts	7359 bytes
packages/shared/src/service-pricing.ts	8690 bytes
packages/shared/tests/pricing.spec.ts	5627 bytes
packages/shared/tests/service-pricing.spec.ts	7152 bytes
packages/shared/tsconfig.json	150 bytes
packages/storage/package.json	410 bytes
packages/storage/src/index.ts	8512 bytes
packages/storage/src/smoke.ts	1135 bytes
packages/storage/tsconfig.json	132 bytes
packages/tool-registry/package.json	648 bytes
packages/tool-registry/src/autonomy.ts	1327 bytes
packages/tool-registry/src/bcryptjs.d.ts	27 bytes
packages/tool-registry/src/equipment-catalog.ts	6819 bytes
packages/tool-registry/src/handlers.ts	427168 bytes
packages/tool-registry/src/index.ts	282 bytes
packages/tool-registry/src/policy/engine.ts	23024 bytes
packages/tool-registry/src/rbac.ts	800 bytes
packages/tool-registry/src/registry.ts	59953 bytes
packages/tool-registry/src/types.ts	1895 bytes
packages/tool-registry/tests/agent-steering.spec.ts	10101 bytes
packages/tool-registry/tests/assessment-attachments.spec.ts	5295 bytes
packages/tool-registry/tests/autonomy.spec.ts	2605 bytes
packages/tool-registry/tests/comms.spec.ts	12474 bytes
packages/tool-registry/tests/contract-tools.spec.ts	10770 bytes
packages/tool-registry/tests/decision-metadata.spec.ts	10909 bytes
packages/tool-registry/tests/dispatch-media.spec.ts	30568 bytes
packages/tool-registry/tests/equipment-catalog-import.spec.ts	4521 bytes
packages/tool-registry/tests/equipment-lookup.spec.ts	7062 bytes
packages/tool-registry/tests/equipment-options.spec.ts	5401 bytes
packages/tool-registry/tests/explain.spec.ts	8538 bytes
packages/tool-registry/tests/financial-exposure.spec.ts	7637 bytes
packages/tool-registry/tests/install-pricing.spec.ts	17281 bytes
packages/tool-registry/tests/job-geo.spec.ts	5881 bytes
packages/tool-registry/tests/killswitch.spec.ts	7050 bytes
packages/tool-registry/tests/lead-care.spec.ts	11732 bytes
packages/tool-registry/tests/policy.spec.ts	3209 bytes
packages/tool-registry/tests/rbac.spec.ts	1013 bytes
packages/tool-registry/tests/receipt-ocr.spec.ts	8228 bytes
packages/tool-registry/tests/review-requests.spec.ts	5729 bytes
packages/tool-registry/tests/service-pricing.spec.ts	20553 bytes
packages/tool-registry/tests/timeclock.spec.ts	14675 bytes
packages/tool-registry/tsconfig.json	150 bytes
scripts/generate-external-pack-manifest.mjs	3123 bytes
scripts/import-legal-pack.ts	11425 bytes
scripts/ops/backup_nightly.sh	3193 bytes
scripts/ops/check_launchd_health.sh	3156 bytes
scripts/ops/check_system_health.sh	33436 bytes
scripts/ops/health_check_and_alert.sh	15180 bytes
scripts/ops/install_launchd_jobs.sh	13458 bytes
scripts/ops/load_smoke.sh	4927 bytes
scripts/ops/load_smoke_record.sh	3325 bytes
scripts/ops/recover_disk_pressure.sh	2021 bytes
scripts/ops/remediate_from_health.sh	6217 bytes
scripts/ops/repair_launchd_jobs.sh	3939 bytes
scripts/ops/restore_drill.sh	7073 bytes
scripts/ops/restore_latest_drill.sh	977 bytes
scripts/ops/rotate_ops_logs.sh	1319 bytes
scripts/ops/verify_backup_snapshot.sh	5159 bytes
scripts/verify-external-pack-manifest.mjs	3267 bytes
tsconfig.base.json	370 bytes
types/bcryptjs/index.d.ts	194 bytes
website/.gitignore	67 bytes
website/README.md	36 bytes
website/attached_assets/Screenshot 2025-06-11 at 10.38.31 AM_1749657412211.png	970974 bytes
website/attached_assets/Screenshot 2025-06-11 at 10.40.58 AM_1749657418686.png	813294 bytes
website/attached_assets/Screenshot 2025-06-11 at 10.41.29 AM_1749657430288.png	1451516 bytes
website/attached_assets/Screenshot 2025-07-04 at 9.17.47 AM_1751638706398.png	156619 bytes
website/attached_assets/Screenshot 2025-07-14 at 11.56.39 PM_1752555413013.png	35679 bytes
website/attached_assets/Screenshot 2025-07-14 at 8.45.41 AM_1752500750292.png	259669 bytes
website/attached_assets/android-chrome-192x192_1749661394574.png	33562 bytes
website/attached_assets/android-chrome-192x192_1749661541924.png	33562 bytes
website/attached_assets/android-chrome-512x512_1749661394576.png	151942 bytes
website/attached_assets/android-chrome-512x512_1749661541929.png	151942 bytes
website/attached_assets/apple-touch-icon_1749661394576.png	29866 bytes
website/attached_assets/apple-touch-icon_1749661541930.png	29866 bytes
website/attached_assets/content-1749388267574.md	4138 bytes
website/attached_assets/content-1749388269005.md	25519 bytes
website/attached_assets/content-1749388950537.md	139140 bytes
website/attached_assets/content-1749389143669.md	4146 bytes
website/attached_assets/content-1749389145287.md	29 bytes
website/attached_assets/content-1749389147089.md	139140 bytes
website/attached_assets/content-1771530463868.md	3921 bytes
website/attached_assets/favicon-16x16_1749661394576.png	649 bytes
website/attached_assets/favicon-16x16_1749661541930.png	649 bytes
website/attached_assets/favicon-32x32_1749661394577.png	1909 bytes
website/attached_assets/favicon-32x32_1749661541931.png	1909 bytes
website/attached_assets/favicon_1749661394577.ico	15406 bytes
website/attached_assets/favicon_1749661541931.ico	15406 bytes
website/attached_assets/official_logo_transparent_1749387933706.png	161793 bytes
website/attached_assets/screenshot-1749388958193.png	550237 bytes
website/attached_assets/screenshot-1749388959890.png	877367 bytes
website/attached_assets/screenshot-1749388960719.png	677106 bytes
website/attached_assets/screenshot-1749389142755.png	677106 bytes
website/attached_assets/screenshot-1749389144585.png	1748515 bytes
website/attached_assets/screenshot-1749389145986.png	550317 bytes
website/client/env.d.ts	166 bytes
website/client/index.html	21952 bytes
website/client/public/Screenshot 2025-06-11 at 10.38.31 AM_1749657412211.png	970974 bytes
website/client/public/Screenshot 2025-06-11 at 10.40.58 AM_1749657418686.png	813294 bytes
website/client/public/Screenshot 2025-06-11 at 10.41.29 AM_1749657430288.png	1451516 bytes
website/client/public/android-chrome-192x192.png	33562 bytes
website/client/public/android-chrome-512x512.png	151942 bytes
website/client/public/apple-touch-icon.png	29866 bytes
website/client/public/favicon-16x16.png	649 bytes
website/client/public/favicon-32x32.png	1909 bytes
website/client/public/favicon.ico	15406 bytes
website/client/public/images/Screenshot 2025-06-11 at 10.38.31 AM_1749657412211.png	970974 bytes
website/client/public/images/Screenshot 2025-06-11 at 10.40.58 AM_1749657418686.png	813294 bytes
website/client/public/images/Screenshot 2025-06-11 at 10.41.29 AM_1749657430288.png	1451516 bytes
website/client/public/mountain1.png	970974 bytes
website/client/public/mountain2.png	813294 bytes
website/client/public/mountain3.png	1451516 bytes
website/client/public/official_logo_transparent_1749387933706.png	161793 bytes
website/client/public/screenshot-1749388958193.png	550237 bytes
website/client/public/screenshot-1749388959890.png	877367 bytes
website/client/public/screenshot-1749388960719.png	677106 bytes
website/client/public/screenshot-1749389142755.png	677106 bytes
website/client/public/screenshot-1749389144585.png	1748515 bytes
website/client/public/screenshot-1749389145986.png	550317 bytes
website/client/src/App.tsx	1335 bytes
website/client/src/components/about-us.tsx	4814 bytes
website/client/src/components/ai-faq-section.tsx	9914 bytes
website/client/src/components/analytics-dashboard.tsx	12875 bytes
website/client/src/components/contact-form.tsx	15538 bytes
website/client/src/components/featured-services.tsx	8201 bytes
website/client/src/components/footer.tsx	5653 bytes
website/client/src/components/geo-optimization.tsx	12533 bytes
website/client/src/components/google-my-business-signals.tsx	3306 bytes
website/client/src/components/header.tsx	7244 bytes
website/client/src/components/hero.tsx	4244 bytes
website/client/src/components/quote-comparison.tsx	18359 bytes
website/client/src/components/service-areas.tsx	2572 bytes
website/client/src/components/services.tsx	4229 bytes
website/client/src/components/testimonials.tsx	4154 bytes
website/client/src/components/ui/accordion.tsx	1977 bytes
website/client/src/components/ui/alert-dialog.tsx	4420 bytes
website/client/src/components/ui/alert.tsx	1584 bytes
website/client/src/components/ui/aspect-ratio.tsx	140 bytes
website/client/src/components/ui/avatar.tsx	1419 bytes
website/client/src/components/ui/badge.tsx	1128 bytes
website/client/src/components/ui/breadcrumb.tsx	2712 bytes
website/client/src/components/ui/button.tsx	1901 bytes
website/client/src/components/ui/calendar.tsx	2695 bytes
website/client/src/components/ui/card.tsx	1858 bytes
website/client/src/components/ui/carousel.tsx	6210 bytes
website/client/src/components/ui/chart.tsx	10481 bytes
website/client/src/components/ui/checkbox.tsx	1056 bytes
website/client/src/components/ui/collapsible.tsx	329 bytes
website/client/src/components/ui/command.tsx	4885 bytes
website/client/src/components/ui/context-menu.tsx	7428 bytes
website/client/src/components/ui/dialog.tsx	3848 bytes
website/client/src/components/ui/drawer.tsx	3021 bytes
website/client/src/components/ui/dropdown-menu.tsx	7609 bytes
website/client/src/components/ui/form.tsx	4120 bytes
website/client/src/components/ui/hover-card.tsx	1251 bytes
website/client/src/components/ui/input-otp.tsx	2154 bytes
website/client/src/components/ui/input.tsx	791 bytes
website/client/src/components/ui/label.tsx	710 bytes
website/client/src/components/ui/menubar.tsx	8605 bytes
website/client/src/components/ui/navigation-menu.tsx	5128 bytes
website/client/src/components/ui/pagination.tsx	2751 bytes
website/client/src/components/ui/popover.tsx	1280 bytes
website/client/src/components/ui/progress.tsx	791 bytes
website/client/src/components/ui/radio-group.tsx	1467 bytes
website/client/src/components/ui/resizable.tsx	1723 bytes
website/client/src/components/ui/scroll-area.tsx	1642 bytes
website/client/src/components/ui/select.tsx	5742 bytes
website/client/src/components/ui/separator.tsx	756 bytes
website/client/src/components/ui/sheet.tsx	4281 bytes
website/client/src/components/ui/sidebar.tsx	23567 bytes
website/client/src/components/ui/skeleton.tsx	261 bytes
website/client/src/components/ui/slider.tsx	1077 bytes
website/client/src/components/ui/switch.tsx	1139 bytes
website/client/src/components/ui/table.tsx	2765 bytes
website/client/src/components/ui/tabs.tsx	1883 bytes
website/client/src/components/ui/textarea.tsx	689 bytes
website/client/src/components/ui/toast.tsx	4845 bytes
website/client/src/components/ui/toaster.tsx	772 bytes
website/client/src/components/ui/toggle-group.tsx	1753 bytes
website/client/src/components/ui/toggle.tsx	1527 bytes
website/client/src/components/ui/tooltip.tsx	1209 bytes
website/client/src/components/why-choose-us.tsx	2543 bytes
website/client/src/hooks/use-analytics.tsx	426 bytes
website/client/src/hooks/use-mobile.tsx	565 bytes
website/client/src/hooks/use-toast.ts	3895 bytes
website/client/src/index.css	3605 bytes
website/client/src/lib/analytics.ts	2430 bytes
website/client/src/lib/attribution.ts	3608 bytes
website/client/src/lib/queryClient.ts	1376 bytes
website/client/src/lib/types.ts	387 bytes
website/client/src/lib/utils.ts	166 bytes
website/client/src/main.tsx	157 bytes
website/client/src/pages/admin.tsx	17534 bytes
website/client/src/pages/home.tsx	1168 bytes
website/client/src/pages/not-found.tsx	711 bytes
website/client/src/pages/thank-you.tsx	2542 bytes
website/components.json	459 bytes
website/drizzle.config.ts	325 bytes
website/package-lock.json	444323 bytes
website/package.json	3986 bytes
website/postcss.config.js	80 bytes
website/server/analytics.ts	11097 bytes
website/server/db.ts	928 bytes
website/server/email.ts	8141 bytes
website/server/index.ts	1902 bytes
website/server/lib/s3.ts	3722 bytes
website/server/routes.ts	13399 bytes
website/server/storage.ts	3883 bytes
website/server/vite.ts	2254 bytes
website/shared/schema.ts	5552 bytes
website/tailwind.config.ts	2627 bytes
website/tsconfig.json	657 bytes
website/vite.config.ts	971 bytes
