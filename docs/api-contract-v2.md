# API v2

`POST /v2/eva/dataset` принимает `{request, disabledSources: string[]}`.
Поля request совместимы с v1: mode, historyMode, start, duration, shift, cutoff,
lightConstraint. Некорректный запрос — HTTP 400; отказ источника — dataset со
статусом источника; ошибка самого сервера — HTTP 500. Размер запроса до 16 KiB.

Сервер на loopback предназначен для локального использования. CORS для
произвольных origin не разрешён. `/v1/eva/dataset` — локальный алиас v2; демо
не использует этот маршрут. Клиент поддерживает схемы 1 и 2 по schemaVersion.

Корневые поля ответа:

| Поле | Смысл |
|---|---|
| schemaVersion | 2 |
| demo | false |
| generatedAt | UTC ISO 8601, время сборки |
| sources[] | Любое число уникальных источников, связь factors[] многие-ко-многим |
| series[] | Разделённые по инструменту измерения/ревизии |
| profile | stepSeconds=30, propagator, objectId=25544, epoch, samples[] |
| factors[] | sep, trapped, gcr, meteor, ops |
| events[] | Выводы/внешние предупреждения, источник не равен фактору |
| coverage | validSamples, expectedSamples, fraction и gaps для каждого ряда |
| gaps[] | Интервалы отсутствия покрытия ряда, механизма или орбиты |
| rules | Версионированные пороги и ограничения моделей |
| context[] | Датированные бюллетени/уведомления, не влияют на риск напрямую |
| limitations[] | Ограничения текущей реализации и конкретного расчёта |

Источник имеет id, name, version, detail, factors, enabled,
status (`fresh|stale|unavailable`), applicable, provenance, url (HTTPS), cadenceMinutes,
ageMinutes, lastSuccess, publishedAt, replayEligible. Времена неизвестных
публикаций/загрузок равны **null**, не эпохе Unix и не времени измерения.
`applicable: false` — источник не даёт данных в этом режиме (например, CelesTrak в
историческом, Space-Track в текущем). Он не считается сбоем и не входит в «N из M».
Успешный ответ без записей (DONKI в спокойные дни) — `fresh`.

Ряд: id, sourceId, instrument, quantity, energy, unit, provenance,
cadenceMinutes, maxAgeMinutes, interpolation, samples. Отсчёт содержит `t`
(UTC Unix ms — конец измерительного интервала), `v` (число либо null), `q`
(`ok|fill|quality|spike|channel_order`), publishedAt, fetchedAt, sourceVersion.
Время внутри ряда строго возрастает. Поля measuredAt/fetchedAt/publishedAt
исходных записей представлены UTC ISO-строками с Z.

Происхождение: `observation|external_forecast|own_computation|model|synthetic`.
В реальном ответе не генерируется синтетическая замена отсутствующих данных.

Профиль: t, lat/lon (градусы), alt (км), sunlit, orbitSourceId, epoch;
магнитные поля L, B (нТл), magLat, rc (GV), ec (MeV), cutoff (`quiet|storm`), saa;
значения sep (pfu), trapped (cm^-2 s^-1), ap8Min/ap8Max, ap8Floor, hp30,
hp30Forecast, neutronRates (counts/s), gcr (доля межпланетного потока ГКЛ выше
обрезания, 0…1), meteor (hits/s) и ops (число сближений TCA ± 30 мин в экране
SOCRATES; null вне 7 суток от снимка или без SOCRATES). Неизвестное равно null.
Отсутствие локальной модели ГКЛ не заменяется наземным счётом NMDB.
У SEP есть происхождение значения: `sepBasis` (`observation|persistence`),
`sepObservedAt` — время замера GOES, `sepBound: true` — оценка сверху (энергия
выше последнего канала или неизвестный индекс). `ap8Floor: true` — AP-8 ниже
нижнего уровня карты (1 см⁻²с⁻¹), поток 0. `sepWarning` — действует ли в этот
момент датированное предупреждение SWPC о протонном событии (WARPX/ALTPX; итоговые
сообщения SUMPX описывают уже закончившееся событие и не учитываются). `false`
означает опрошенный и молчащий канал предупреждений, `null` — канал не опрошен.

`rules.decisionMechanisms` перечисляет механизмы, полнота которых нужна для
вывода; остальные — контекст (`rules.contextMechanisms`). Если поле отсутствует,
решают все пять механизмов. Статус механизма в окне:
`insufficient|review|acceptable|context`; контекстный механизм бывает только
`review` или `context`. Значение механизма в окне: SEP — pfu·с, захваченные —
см⁻², метеоры — ожидаемые попадания, ГКЛ — средний % потока, сближения — число
сближений; при неполном покрытии — null.

Replay производится **до** интерполяции, QA и модели. Записи без publishedAt
исключены. Ревизия выбирается по максимальному publishedAt <= cutoff;
fetchedAt используется только для разрешения повторных загрузок одной ревизии.
В archive неизвестные публикации разрешены и обозначены явно.

Результат `computePlan` содержит factors по каждому окну, их coverage/value/peak,
размерности, status, rank, position (место в ранжировании) и confidence
`{score,level,limiting,criteria,reasons}`, а также `best` (id показанных лучших окон:
все хорошие либо два лучших, если хороших нет) и `goodCount`.

Вероятность протонного события `sepEventProbability` поступает из двух источников
сразу: текстового 3-day forecast SWPC (есть время выпуска) и JSON
`solar_probabilities` (времени выпуска нет, резерв). На пересечении интервалов
побеждает выпуск с известной публикацией, среди равных — более поздний.

Уверенность собирается по правилу шкалы достоверности NASA-STD-7009: каждый
критерий получает `score` 0–4 против заявленного свидетельства, сводный `score`
равен **минимуму** по критериям, `level` — `high` при 3–4, `medium` при 2, `low`
при 0–1, а `limiting` перечисляет критерии на этом минимуме. Критерий несёт
`id`, `label`, `measures` (что проверяется), `score`, `level`, `detail`
(состояние сейчас) и `hint` (как поднять; `null` на максимуме). Критерии:
`coverage`, `freshness`, `forecast`, `model`, `context`. Оценка не является
вероятностью безопасности. Окно, целиком достроенное базовым прогнозом
«последнее наблюдение сохраняется», получает по `forecast` не выше 2, даже когда
прогноз SWPC его подтверждает. Подтверждение градуировано: если горизонт выпуска
заканчивается внутри окна, подтверждённая часть сохраняется и критерий равен 1,
а не 0. Действующее предупреждение SWPC снимает подтверждение полностью (1). Итог outcome:
`recommendation|no_improvement|insufficient`. Неполные окна никогда не дают
подтверждённого улучшения. rank служит сравнению, а не скалярной оценкой риска.
