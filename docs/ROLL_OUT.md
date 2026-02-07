# Rollout checklist (план внедрения)

## 1) Baseline (до изменений)
Зафиксировать **до включения новых фич**:
- средняя скорость: `blocks_done_per_min`
- `requests/min` и `tokens/min`
- доля `429` и `timeouts`
- `avg_batch_size` для translate/proofread
- `prompt cache hit%`

Сохранить:
- **контрольную страницу** (URL)
- **контрольный лог** (JSON логи + скриншот Debug UI “Health”)

---

## 2) Порядок наката (строго по фазам, каждый шаг под фича-флагом)

### Фаза 1: стабильность и анти-зацикливание (обязательные)
- (S1) ThroughputController + backoff/jitter на 429 (must-have)
- (S2) ResiliencePolicy: budget + fallback ladder (split/model switch/short context/per-segment)
- (S3) Guardrails-инварианты: count match / ids subset / placeholders match

**Gate (после S1–S3):**
- 429 **не вызывают “шторм”** ретраев
- `blocks_done_per_min > 0` при любой нагрузке
- **нет блоков** `in_progress > 10 мин`

### Фаза 2: “сильные ускорители без риска качества”
- (P1) UI pipeline: TM + dedup + no proofread for UI
- (P2) Doc-level dedup (super-batching по странице)
- (P3) Proofread AUTO gate + top-K + delta-proofread
- (P4) ModelRouter (pool моделей) — **только не дороже** preferred

**Gate (после P1–P4):**
- `translateCalls/страница` падает **>= 30%** на типичных страницах
- `proofreadCalls/страница` падает **>= 40%** в auto режиме
- `output_tokens` на proofread падают заметно (delta mode)
- `prompt cache hit%` растёт

### Фаза 3: advanced (включать, только если всё стабильно)
- (A1) Predicted outputs только для repair (auto-disable при high rejected_ratio)
- (A2) Scheduler + preflight governor (RPM/TPM-aware batching)
- (A3) Unified RequestRunner (OOP) + удаление дубликатов
- (A4) Batch Turbo Mode как опциональный prewarm (не влияет на интерактив)
- (A5) Cleanup + Jest tests + CI (guard against regressions)

---

## 3) Rollback plan
Все функции должны иметь feature flags:
- `enableUiPipeline`
- `enableDocDedup`
- `proofreadMode` (always/auto/never)
- `enableDeltaProofread`
- `enableModelRouter`
- `enableScheduler`
- `enablePredictionRepair`
- `enableBatchTurbo`

**Если gate не пройден** — отключить последнюю фичу и повторить тест.

---

## 4) Acceptance gates (автоматические критерии)

### GATE-1 (стабильность)
- `oldest_in_progress_age_sec < 600`
- `request_success_ratio >= 0.85`
- `429_count` снижается с течением времени (через backoff), **нет шторма** `retry_count`

### GATE-2 (скорость)
- `blocks_done_per_min >= baseline * 1.5` (на контрольной странице)
- `requests_sent <= baseline * 0.7`
- `proofread_calls_total <= baseline * 0.6` (в auto режиме)

### GATE-3 (качество/целостность)
- `guardrail.violation == 0` на контрольном прогоне
- `placeholders violations == 0`
- `len mismatches == 0`

> Если violation > 0, **должно быть видно**, что `resilience.escalate` привёл к завершению **без FAILED**.
