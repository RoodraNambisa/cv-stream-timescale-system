\echo '1. 每个设备执行过的 CV 任务数量'
SELECT
  d.id AS device_id,
  d.device_name,
  count(t.task_id) AS task_count
FROM device d
LEFT JOIN cv_task t ON t.device_id = d.id
GROUP BY d.id, d.device_name
ORDER BY d.id;

\echo '2. 某设备在最近 30 分钟内的平均检测置信度'
SELECT
  d.id AS device_id,
  d.device_name,
  round(avg(s.confidence)::numeric, 4) AS avg_confidence
FROM cv_detection_stream s
JOIN device d ON d.id = s.device_id
WHERE d.id = 1
  AND s.time >= now() - INTERVAL '30 minutes'
  AND s.time < now()
GROUP BY d.id, d.device_name;

\echo '3. 按 10 秒统计每个设备检测到的各类物体数量'
SELECT
  time_bucket('10 seconds', s.time) AS bucket,
  d.device_name,
  s.object_class,
  count(*) AS detection_count
FROM cv_detection_stream s
JOIN device d ON d.id = s.device_id
WHERE s.time >= now() - INTERVAL '30 minutes'
GROUP BY bucket, d.device_name, s.object_class
ORDER BY bucket, d.device_name, s.object_class;

\echo '4. 按 1 分钟计算平均置信度'
SELECT
  time_bucket('1 minute', time) AS bucket,
  device_id,
  object_class,
  round(avg(confidence)::numeric, 4) AS avg_confidence
FROM cv_detection_stream
WHERE time >= now() - INTERVAL '30 minutes'
GROUP BY bucket, device_id, object_class
ORDER BY bucket, device_id, object_class;

\echo '5. 最近 5 分钟出现频次最高的物体类别'
SELECT
  object_class,
  count(*) AS detection_count
FROM cv_detection_stream
WHERE time >= now() - INTERVAL '5 minutes'
GROUP BY object_class
ORDER BY detection_count DESC, object_class
LIMIT 1;

\echo '6. 某设备在最近 30 秒内置信度低于 0.6 的检测记录'
SELECT
  time,
  device_id,
  task_id,
  object_class,
  confidence,
  bbox_x1,
  bbox_y1,
  bbox_x2,
  bbox_y2
FROM cv_detection_stream
WHERE device_id = 1
  AND time >= now() - INTERVAL '30 seconds'
  AND confidence < 0.6
ORDER BY time DESC;

\echo '7. JOIN device 表输出设备名称和检测热度图数据'
SELECT
  time_bucket('10 seconds', s.time) AS bucket,
  d.device_name,
  s.object_class,
  count(*) AS heat_value
FROM cv_detection_stream s
JOIN device d ON d.id = s.device_id
WHERE s.time >= now() - INTERVAL '30 minutes'
GROUP BY bucket, d.device_name, s.object_class
ORDER BY bucket, d.device_name, s.object_class;

\echo '8. 连续聚合视图：每分钟、每设备、每类别的检测次数和平均置信度'
CALL refresh_continuous_aggregate(
  'minutely_object_stats',
  now() - INTERVAL '1 hour',
  now()
);

SELECT
  bucket,
  d.device_name,
  m.object_class,
  m.detection_count,
  round(m.avg_confidence::numeric, 4) AS avg_confidence
FROM minutely_object_stats m
JOIN device d ON d.id = m.device_id
WHERE bucket >= now() - INTERVAL '1 hour'
ORDER BY bucket DESC, d.device_name, m.object_class;
