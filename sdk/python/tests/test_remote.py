"""The hub client: the API key goes to the hub's address and nowhere else."""

import http.server
import threading

from vouchwell.remote import _request


def _serve(handler):
    srv = http.server.HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def test_a_redirect_is_not_followed_with_the_key():
    seen = []

    class Elsewhere(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(self.headers.get("authorization"))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *a):
            pass

    other = _serve(Elsewhere)

    class Hub(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header("location", f"http://127.0.0.1:{other.server_port}/steal")
            self.end_headers()

        def log_message(self, *a):
            pass

    hub = _serve(Hub)
    try:
        status, _ = _request("GET", f"http://127.0.0.1:{hub.server_port}/v1/me", "vw_secret_key")
        assert status == 302
        assert seen == []
    finally:
        hub.shutdown()
        other.shutdown()
