# Контракт входных данных v1

Настройка: `dist/config.js`, `apiBaseUrl: 'https://your-backend.example'`. Endpoint: `POST /v1/eva/dataset`, JSON, тайм-аут 15 с. API не должен доверять ограничениям формы: валидируйте параметры на сервере.

## Запрос

```json
{
  "request": {
    "mode": "history",
    "historyMode": "replay",
    "start": "2024-05-10T10:00:00Z",
    "duration": 4,
    "shift": 12,
    "cutoff": "2024-05-10T09:00:00Z",
    "lightConstraint": false
  },
  "disabledSources": []
}
```

`mode`: current/history. `historyMode`: archive/replay. Длительность 1–8 ч, shift 0–24 ч вперёд. Все строки времени — ISO 8601 UTC. Числовые интервалы — Unix **миллисекунды**. Срез обязателен только для replay, не позже начала ВКД.

## Ответ

```json
{
  "demo": false,
  "sources": [
    {
      "id": "weather",
      "name": "NOAA SWPC",
      "detail": "Космическая погода",
      "version": "immutable-source-version",
      "publishedAt": "2024-05-10T07:00:00Z",
      "lastSuccess": "2024-05-10T08:58:00Z",
      "cadenceMinutes": 5,
      "status": "fresh",
      "enabled": true,
      "provenance": "external_forecast",
      "url": "https://www.swpc.noaa.gov/"
    }
  ],
  "events": [
    {
      "id": "event-unique-id",
      "title": "Повышенный поток протонов",
      "type": "SEP",
      "factor": "weather",
      "sourceId": "weather",
      "start": 1715331600000,
      "end": 1715347800000,
      "publishedAt": "2024-05-10T07:00:00Z",
      "origin": "Внешний прогноз",
      "value": 12,
      "unit": "pfu (> 10 MeV)",
      "weight": 1,
      "rule": "Идентификатор и текст правила оценки",
      "limitation": "Не расчёт дозы экипажа",
      "version": "immutable-event-version"
    }
  ],
  "gaps": [],
  "orbit": {
    "epoch": 1715320800000,
    "format": "DEMO / не TLE",
    "model": "synthetic-orbit-v1",
    "inclination": 51.6,
    "periodMinutes": 92.7
  },
  "verification": {
    "publishedAt": "2024-05-10T20:00:00Z",
    "forecast": 12,
    "observed": 9,
    "unit": "pfu",
    "complete": false
  }
}
```

Для работающей оценки должны присутствовать **все три** записи `sources`: `weather`, `conjunction`, `orbit`. Пример сокращён до одной. Недоступный источник возвращается с `status: unavailable`, а не пропускается. `status`: fresh/stale/unavailable. Устаревшие и недоступные источники исключаются из оценки и снижают уверенность. Сервер определяет актуальность относительно запрошенного режима и информационного среза; время загрузки не заменяет время публикации.

`factor` поддерживает weather/conjunction. Событие сближения содержит `tca` в миллисекундах, относится именно к МКС и уже имеет оценочный интервал (например TCA ± 30 мин). API должен выдавать итоговую версию каждого события на срезе, а не дублирующие ревизии. UI повторно фильтрует публикации после cutoff. В архивном режиме поздние публикации допустимы. Наблюдения, появившиеся позже cutoff, запрещено включать в массив событий оценки; они относятся только к `verification`.

`gaps`: массив `{ sourceId, start, end, publishedAt, reason }`. Неизвестное покрытие должно быть представлено явно на **всём горизонте поиска**. Отсутствие событий означает отсутствие известных предупреждений только при полном покрытии, а не отсутствие риска.

## Этап физической орбитальной интеграции

Текущий `orbitPoint()` — исключительно синтетическая модель. Чтобы использовать реальные TLE/OMM, замените её физическим распространителем или предварительно вычисленными отсчётами API; и карта, и `computePlan()` должны читать один набор координат и флагов освещённости. Не достаточно поместить TLE в поле `format`. Перед использованием реальных данных также требуется заменить demo-правила, версионирование алгоритма и проверить ограничения модели.

## Результат оценки / экспорт

`plan` включает запрос, cutoff, generatedAt, algorithmVersion, demo, sources с `eligible`, события, original, alternative, recommended, все candidates и limitations. У каждого окна есть start/end, warnings с overlapMinutes, gaps, missing, penalty, confidence, status. Статусы: acceptable/review/insufficient. Рекомендация сортирует по отсутствующим источникам, наличию пробелов, условной оценке риска, времени начала. UI и экспорт используют один зафиксированный снимок; при изменении параметров сохранение отключается до пересчёта.
