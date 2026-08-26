FROM clickhouse/clickhouse-server:24.8

COPY infra/clickhouse/render-low-memory.xml /etc/clickhouse-server/config.d/axel-low-memory.xml
COPY infra/clickhouse/render-user-profile.xml /etc/clickhouse-server/users.d/axel-low-memory.xml
