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
location /grafana/ {
    auth_request       /_hpx/session;
    error_page 401   = @hpx_sign_in;

    proxy_pass         http://grafana;
    proxy_http_version 1.1;
    proxy_set_header   Connection        $connection_upgrade;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Host              $host;
    proxy_set_header   Cookie            $hpx_cookie_for_grafana;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $hpx_proto;
    proxy_read_timeout 3600s;   # Grafana Live keeps its WebSocket open
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
