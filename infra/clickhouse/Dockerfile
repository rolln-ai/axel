FROM clickhouse/clickhouse-server:24.8@sha256:1ffa82edee000a42c09313bd9f1293d94c570aee74babc1b3ca9983a35fa597b

COPY infra/clickhouse/render-low-memory.xml /etc/clickhouse-server/config.d/axel-low-memory.xml
COPY infra/clickhouse/render-user-profile.xml /etc/clickhouse-server/users.d/axel-low-memory.xml
