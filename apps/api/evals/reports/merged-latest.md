# TriageAI eval report

- Generated: 2026-10-24T18:15:48.605Z
- Result: **PASS**
- Subject model: —
- Baseline model: —

| Suite          | Status | Gates                                                                                | Metrics                                                                        |
| -------------- | ------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| classification | passed | macroF1=0.7, p95LatencyMs=500, falseAutoRoutingCount=0                               | macroF1=0.7824, p95LatencyMs=3.1, falseAutoRoutingCount=0                      |
| retrieval      | passed | recallAt3=0.8                                                                        | recallAt3=1, mrr=1                                                             |
| generation     | passed | groundedness=0.8, refusalCorrectness=0.8, citationCoverage=0.8, validationPassRate=1 | groundedness=1, refusalCorrectness=1, citationCoverage=1, validationPassRate=1 |

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
  "validationPassRate": 1
}
```

Sources: classification 2026-10-23T09:34:43Z, retrieval 2026-10-23T10:52:40.596Z
