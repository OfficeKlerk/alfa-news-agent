# Данные

Крупные исходные данные организаторов **не хранятся в git** (убраны из истории — клон лёгкий). Скачайте и положите сюда.

## Что скачать (ссылки — в ТЗ: Приложение 1 и 2)
| Куда | Что |
|---|---|
| `data/appendix_1/` | `df_Uid_data_hack.csv`, `df_Fid_Uid_link_hack.csv`, `df_Uid_payment_hack.csv` |
| `data/appendix_2/` | 9 PDF аналитики ЦМИ Альфа-Банка |
| `data/*.csv.gz` | gzip CSV для Node-импорта (`gzip -k data/appendix_1/*.csv`) |

## Уже в репозитории (не скачивать)
`data/research.json` (OCR-корпус RAG), `data/demo/` (fixtures), `data/training_v1|v2/`, `data/manifest.json`, `data/demo_news.json`.

CI и офлайн-проверки используют fixtures/синтетику — данные организаторов не требуют.

## Синтетические gz в репозитории
`data/df_*.csv.gz` — **крошечные синтетические** (3 компании) для сборки/CI и demo-запуска из клона. Для полного объёма: `gzip -c data/appendix_1/df_Uid_data_hack.csv > data/df_Uid_data_hack.csv.gz` (и т.д.) — заменят синтетические.
