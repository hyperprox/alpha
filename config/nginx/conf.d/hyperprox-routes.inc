# Routes shared by the :443 server and the :80 server's non-redirected requests (see hyperprox.conf).
# The .inc suffix keeps nginx.conf's `include conf.d/*.conf` from loading this a second time on its own.

location = /nginx-health {
    access_log off;
    default_type text/plain;
    return 200 "ok\n";
}

# The first-run wizard: its page at /setup, its API under /api/setup/. The longer prefix wins over /api,
# so these never reach HyperProx's own API. Once setup completes the wizard exits and these answer 502.
location /setup {
    proxy_pass         http://setup;
    proxy_http_version 1.1;
    proxy_set_header   Connection        "";
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $hpx_proto;
}

location /api/setup/ {
    proxy_pass         http://setup;
    proxy_http_version 1.1;
    proxy_set_header   Connection        "";
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $hpx_proto;
    proxy_read_timeout 60s;   # the service scan allows itself 20 s
}

location /api {
    proxy_pass         http://api;
    proxy_http_version 1.1;
    proxy_set_header   Connection        "";
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $hpx_proto;
    proxy_read_timeout 180s;  # vault sign-in plus first migration can take ~30 s
}

# Live updates (/ws) and the terminal (/ws/terminal/...).
location /ws {
    proxy_pass          http://api;
    proxy_http_version  1.1;
    proxy_set_header    Upgrade           $http_upgrade;
    proxy_set_header    Connection        $connection_upgrade;
    proxy_set_header    Host              $host;
    proxy_set_header    X-Real-IP         $remote_addr;
    proxy_set_header    X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header    X-Forwarded-Proto $hpx_proto;
    proxy_read_timeout  3600s;
    proxy_send_timeout  3600s;
}

# Grafana is for signed-in people only. Its anonymous viewer is on 127.0.0.1:3003, and this is the only way
# to it: every request (assets, queries, the live WebSocket) first asks the API whether it carries a valid
# HyperProx session while HyperProx is unlocked. 401 (no session, or locked) sends the browser to sign in;
# 403 (an API token) stays 403; any other answer, the API being down included, is a 500. It fails closed.
location = /_hpx/session {
    internal;
    proxy_pass              http://api/api/auth/check;
    proxy_method            GET;          # Grafana POSTs its queries; the check is always a GET
    proxy_http_version      1.1;
    proxy_pass_request_body off;
    # A stuck API must not hold every Grafana asset for a minute: answer within seconds (a 500, closed).
    proxy_connect_timeout   2s;
    proxy_read_timeout      5s;
    proxy_set_header        Content-Length    "";
    proxy_set_header        Connection        "";
    proxy_set_header        Upgrade           "";   # a WebSocket request's check is a plain request
    proxy_set_header        Host              $host;
    proxy_set_header        X-Real-IP         $remote_addr;
    proxy_set_header        X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header        X-Forwarded-Proto $hpx_proto;
    proxy_set_header        X-Original-URI    $request_uri;
}

location @hpx_sign_in {
    return 302 /login?next=%2Fmonitoring;
}

# Grafana serves from the /grafana/ sub-path itself (GF_SERVER_SERVE_FROM_SUB_PATH), so the path is passed
# through whole rather than stripped.
#
# Grafana gets no Cookie and no Authorization header at all: its login form, basic auth and plugin admin
# are off (docker-compose.yml), so it needs neither, and HyperProx's session never reaches it.
#
# The check runs once per request, so a Grafana Live WebSocket opened before a sign-out or a lock carries
# on until it closes or sits idle for proxy_read_timeout (docs/security.md).
location /grafana/ {
    auth_request       /_hpx/session;
    error_page 401   = @hpx_sign_in;

    proxy_pass         http://grafana;
    proxy_http_version 1.1;
    proxy_set_header   Connection        $connection_upgrade;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Host              $host;
    proxy_set_header   Cookie            "";
    proxy_set_header   Authorization     "";
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $hpx_proto;
    proxy_read_timeout 300s;
}

# Grafana's raw datasource proxy and its datasource list (which shows Prometheus's address) are not needed
# by dashboards, which query through /api/ds/query. Refused to everyone, signed in or not.
location /grafana/api/datasources/proxy/ {
    return 403;
}
location = /grafana/api/datasources {
    return 403;
}

location / {
    proxy_pass         http://frontend;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Connection        $connection_upgrade;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $hpx_proto;
}
