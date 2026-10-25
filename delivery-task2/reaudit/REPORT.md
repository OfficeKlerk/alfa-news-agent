# Task 3 — локальная автоматическая приёмка

Результат: **LOCAL_AUTOMATION_PASS**.

Реальный Qwen, внешний IdP, production-стенд и человеческая оценка не проверялись. Это не production PASS.

Целостность исходников: PASS.

| Проверка | Статус | Секунды | Лог |
|---|---|---:|---|
| contracts | PASS | 0.05 | [contracts.txt](contracts.txt) |
| typecheck | PASS | 2.864 | [typecheck.txt](typecheck.txt) |
| build | PASS | 3.374 | [build.txt](build.txt) |
| node-tests | PASS | 14.689 | [node-tests.txt](node-tests.txt) |
| python-tests | PASS | 4.853 | [python-tests.txt](python-tests.txt) |
| bundled-news | PASS | 0.159 | [bundled-news.txt](bundled-news.txt) |
| offline-evaluation | PASS | 0.569 | [offline-evaluation.txt](offline-evaluation.txt) |
| bank-retrieval | PASS | 1.028 | [bank-retrieval.txt](bank-retrieval.txt) |
| personalization | PASS | 0.389 | [personalization.txt](personalization.txt) |
| smoke-default | PASS | 1.036 | [smoke-default.txt](smoke-default.txt) |
| smoke-python-ranker | PASS | 1.033 | [smoke-python-ranker.txt](smoke-python-ranker.txt) |
| smoke-native | PASS | 1.306 | [smoke-native.txt](smoke-native.txt) |

Полный протокол и команды: REPORT.json. Следующий этап — независимые сценарии и стенд из TASK3_CONTEXT.md.
