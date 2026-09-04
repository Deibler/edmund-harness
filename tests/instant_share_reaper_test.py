import importlib.util
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent.parent / "skills" / "instant-share" / "scripts" / "reap.py"
SPEC = importlib.util.spec_from_file_location("instant_share_reap", SCRIPT)
REAP = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = REAP
SPEC.loader.exec_module(REAP)


class InstantShareReaperTests(unittest.TestCase):
    def setUp(self):
        self.state = {
            "ARTIFACT_ID": "artifact-id",
            "ARTIFACT_PATH": "/tmp/artifact-safe",
            "STARTED": "2026-08-10T12:00:00Z",
            "EXPIRE_MINUTES": "60",
            "PORT": "61234",
        }

    def test_target_matching_does_not_match_an_unrelated_bare_id(self):
        self.assertTrue(REAP.matching_target(self.state, "artifact-id"))
        self.assertTrue(REAP.matching_target(self.state, "/tmp/artifact-safe"))
        self.assertFalse(REAP.matching_target(self.state, "some-other-id"))

    def test_expiry_is_computed_from_the_recorded_utc_start(self):
        self.assertEqual(
            REAP.expiry_time(self.state), datetime(2026, 8, 10, 13, 0, tzinfo=timezone.utc)
        )

    def test_quick_tunnel_must_match_the_recorded_local_port(self):
        good = REAP.ProcessInfo(
            10,
            "cloudflared tunnel --url http://127.0.0.1:61234",
            datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc),
        )
        named = REAP.ProcessInfo(
            11,
            "cloudflared tunnel run --token-file /tmp/permanent.token",
            datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc),
        )
        wrong_port = REAP.ProcessInfo(
            12,
            "cloudflared tunnel --url http://127.0.0.1:60000",
            datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc),
        )
        self.assertTrue(REAP.tunnel_owned(good, self.state, None, False))
        self.assertFalse(REAP.tunnel_owned(named, self.state, None, False))
        self.assertFalse(REAP.tunnel_owned(wrong_port, self.state, None, False))


if __name__ == "__main__":
    unittest.main()
