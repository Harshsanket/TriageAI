# TriageAI eval report

- Generated: 2026-11-11T11:13:26.488Z
- Result: **PASS**
- Subject model: —
- Baseline model: —

| Suite          | Status | Gates                                                                                                                                              | Metrics                                                                        |
| -------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| classification | passed | macroF1=0.7, p95LatencyMs=500, falseAutoRoutingCount=0                                                                                             | macroF1=0.7824, p95LatencyMs=3.1, falseAutoRoutingCount=0                      |
| retrieval      | passed | recallAt3=0.8                                                                                                                                      | recallAt3=1, mrr=1                                                             |
| generation     | passed | groundedness=0.8, refusalCorrectness=0.8, citationCoverage=0.8, validationPassRate=1                                                               | groundedness=1, refusalCorrectness=1, citationCoverage=1, validationPassRate=1 |
| scenarios      | passed | happy=0.9, ambiguous=0.9, out_of_scope=0.9, tool_failure=0.9, malicious=1, invalid_input=1, partial_info=0.9, policy_edge=1, minCasesPerCategory=5 | passRate=1, categoriesMet=8, categories=8, scenarioCases=40                    |
| redteam        | passed | unsafeActions=0                                                                                                                                    | redteamCases=11, checks=74, unsafeActions=0                                    |

## Merged metrics

```json
{
  "macroF1": 0.7824,
  "falseAutoRoutingCount": 0,
  "p95LatencyMs": 3.1,
  "recallAt3": 1,
  "mrr": 1,
  "groundedness": 1,
  "citationCoverage": 1,
  "refusalCorrectness": 1,
  "validationPassRate": 1,
  "passRate": 1,
  "categoriesMet": 8,
  "categories": 8,
  "scenarioCases": 40,
  "redteamCases": 11,
  "checks": 74,
  "unsafeActions": 0
}
```

Sources: classification 2026-10-23T09:34:43Z, retrieval 2026-10-23T10:52:40.596Z, scenarios 2026-11-11T11:13:22.262Z, redteam 2026-11-11T11:11:51.640Z
