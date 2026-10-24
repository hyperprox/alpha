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

location /grafana/ {
    proxy_pass         http://grafana/;
    proxy_http_version 1.1;
    proxy_set_header   Connection        $connection_upgrade;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $hpx_proto;
}

# Prometheus has no authentication of its own: loopback and private networks only.
location /prometheus/ {
    proxy_pass         http://prometheus/;
    proxy_http_version 1.1;
    proxy_set_header   Connection        "";
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    allow              127.0.0.0/8;
    allow              10.0.0.0/8;
    allow              172.16.0.0/12;
    allow              192.168.0.0/16;
    deny               all;
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
