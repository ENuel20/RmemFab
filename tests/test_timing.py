"""Closed-form timing checks (A1.1 single tier, A1.2 queue saturation)."""
import unittest

from rmemfab.config.scenario import LinkSpec, Route, TierSpec
from rmemfab.memory.servers import Fabric, LocalTier, Server

PAGE = 2 * 1024 * 1024


def tier(lat=90.0, bw=400.0):
    return TierSpec(1 << 40, lat, bw)


def one_link_fabric():
    link = LinkSpec("l0", "n0", "pool", 180.0, 48.0, None, None, True)
    pool_tier = TierSpec(1 << 40, 10.0, 1e9)
    routes = {("n0", "pool"): Route([("l0", "fwd")], [])}
    return Fabric({"l0": link}, {"pool": pool_tier}, {"pool": Server(1e9)}, {}, routes)


class TestClosedForm(unittest.TestCase):
    def test_single_tier_hit_latency(self):
        """A1.1: each hit on an idle tier costs exactly L + n/B."""
        t = LocalTier(tier())
        lats, _ = t.access(0.0, 8, PAGE, write=False)
        for v in lats:
            self.assertAlmostEqual(v, 90.0 + PAGE / 400.0, delta=1.0)

    def test_single_tier_service_time(self):
        """A1.1: total service time equals N * n / B (latency overlaps)."""
        t = LocalTier(tier())
        _, fin = t.access(0.0, 8, PAGE, write=False)
        self.assertAlmostEqual(t.server.busy_ns, 8 * PAGE / 400.0, delta=1e-6)
        self.assertAlmostEqual(fin, 8 * (90.0 + PAGE / 400.0), delta=1.0)

    def test_back_to_back_transfers(self):
        """A1.2: pipelined transfers complete at L + i*n/B."""
        fab = one_link_fabric()
        lats, fin, qd, _, retx = fab.transfer("n0", "pool", 0.0, 4, PAGE, False, pipelined=True)
        self.assertEqual(retx["attempts"], 1)
        self.assertEqual(retx["lost"], [])
        per = max(PAGE / 48.0, PAGE / 1e9)
        fixed = 180.0 + 10.0
        for i, v in enumerate(lats, start=1):
            self.assertAlmostEqual(v, fixed + per * i, delta=1.0)
        self.assertAlmostEqual(fin, fixed + per * 4, delta=1.0)
        self.assertEqual(qd, 0.0)

    def test_saturation_increases_completion_and_queue(self):
        """A1.2: doubling offered bytes on a saturated link increases both
        completion time and time-weighted queue depth."""
        def run(k):
            fab = one_link_fabric()
            _, fin, _, _, _ = fab.transfer("n0", "pool", 0.0, k, PAGE, False, pipelined=True)
            fab.finish(fin)
            s = fab.links["l0"]["rev"]  # fetch data flows against path order
            return fin, s.q_area
        fin4, q4 = run(4)
        fin8, q8 = run(8)
        self.assertGreater(fin8, fin4)
        self.assertGreater(q8, q4)


if __name__ == "__main__":
    unittest.main()
