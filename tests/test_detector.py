"""Tests for scripts/detector.py. Each test runs it in a fake home with fake chats, never the real ones.

    python3 -m unittest discover -s tests -v
"""
import contextlib, io, json, os, shutil, sys, tempfile, time, unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import detector


def usage_line(read, sidechain=False):
    return json.dumps({"isSidechain": sidechain, "message": {"usage": {
        "input_tokens": 10, "cache_read_input_tokens": read - 1010, "cache_creation_input_tokens": 1000}}},
        separators=(",", ":"))


class Detector(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.home = os.path.join(self.tmp, "home")
        self.skill = os.path.join(self.tmp, "skill")  # its own config.json, never the real one
        os.makedirs(self.skill)
        self.projects = os.path.join(self.home, ".claude", "projects")
        for name, value in (("CONFIG", os.path.join(self.skill, "config.json")), ("PROJECTS", self.projects)):
            patcher = mock.patch.object(detector, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.work = os.path.join(self.tmp, "My Game")  # a space, like many real folders
        os.makedirs(self.work)
        os.makedirs(self.projects)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_it(self, *args, cwd=None, sid=None, auto=None):
        env = {"HOME": self.home}  # nothing else, so no real session id or auto-compact window
        if sid is not None:
            env["CLAUDE_CODE_SESSION_ID"] = sid
        if auto is not None:
            env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = auto
        out, here = io.StringIO(), os.getcwd()
        os.chdir(cwd or self.work)
        try:
            with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(sys, "argv", ["detector.py", *args]), \
                    contextlib.redirect_stdout(out):
                code = detector.main()  # a crash fails the test with its traceback
        finally:
            os.chdir(here)
        return code, out.getvalue()

    def chat(self, folder, name, lines, age=0):
        d = os.path.join(self.projects, folder)
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, name + ".jsonl")
        with open(path, "w") as f:
            f.write("\n".join(lines) + "\n")
        t = time.time() - age
        os.utime(path, (t, t))
        return path

    def folder_of(self, path):
        return "".join(c if c.isalnum() else "-" for c in os.path.realpath(path))

    def config(self):
        with open(os.path.join(self.skill, "config.json")) as f:
            return json.load(f)

    # ---------- --report ----------
    def test_no_chats(self):
        code, out = self.run_it("--report")
        self.assertEqual(code, 0)
        self.assertIn("No chat found yet", out)

    def test_numbers_skip_subagents_and_broken_lines(self):
        self.chat(self.folder_of(self.work), "a", [
            '{"type":"user","message":{"content":"hi"}}',
            usage_line(84000),
            "{broken json",
            '{"message":{"usage":"not an object"}}',
            '{"message":{"usage":null}}',
            '{"message":{"usage":[1,2]}}',
            usage_line(150000),
            usage_line(900000, sidechain=True),  # a subagent's reply: not this chat's size
        ])
        code, out = self.run_it("--report")
        self.assertEqual(code, 0)
        self.assertIn("about 150,000 tokens (limit 400,000, 37%). Under 70%.", out)
        self.assertIn("Setup (first message): about 84,000. This chat added: about 66,000.", out)
        self.assertIn("(newest chat in this folder)", out)

    def test_over_the_limit(self):
        self.chat(self.folder_of(self.work), "a", [usage_line(90000), usage_line(420000)])
        _, out = self.run_it("--report")
        self.assertIn("(limit 400,000, 105%). Map it with /tongs now, then compact.", out)

    def test_exact_chat_by_session_id_from_any_folder(self):
        self.chat(self.folder_of(self.work), "newer", [usage_line(300000)])
        self.chat("-somewhere-else", "abc-123", [usage_line(50000), usage_line(77000)], age=500)
        _, out = self.run_it("--report", sid="abc-123")
        self.assertIn("about 77,000 tokens", out)
        self.assertNotIn("newest chat", out, "found exactly, so no guess note")

    def test_unknown_or_hostile_session_id_falls_back(self):
        self.chat(self.folder_of(self.work), "a", [usage_line(120000)])
        self.chat("-x", "secret", [usage_line(999000)])
        for sid in ["not-there", "*", "../-x/secret", "../../outside/chat", "a b", ""]:
            _, out = self.run_it("--report", sid=sid)
            self.assertIn("about 120,000 tokens", out, sid)
            self.assertIn("(newest chat in this folder)", out, sid)

    def test_newest_chat_in_folder_wins(self):
        self.chat(self.folder_of(self.work), "old", [usage_line(111000)], age=3600)
        self.chat(self.folder_of(self.work), "new", [usage_line(222000)])
        _, out = self.run_it("--report")
        self.assertIn("about 222,000 tokens", out)

    def test_other_folder_is_a_labelled_guess(self):
        self.chat("-another-project", "a", [usage_line(130000)])
        _, out = self.run_it("--report")
        self.assertIn("about 130,000 tokens", out)
        self.assertIn("a guess", out)

    def test_huge_chat_is_fast_and_reads_the_end(self):
        filler = '{"type":"user","message":{"content":"' + "x" * 5000 + '"}}'
        # Like a real chat: the last reply's usage sits in one long line with the reply's text, then more lines follow.
        last = json.loads(usage_line(333000))
        last["message"]["content"] = "y" * 1_000_000
        path = self.chat(self.folder_of(self.work), "big", [usage_line(84000)] + [filler] * 4000
                         + [usage_line(200000), json.dumps(last)] + [filler] * 400)
        self.assertGreater(os.path.getsize(path), 20_000_000)
        start = time.time()
        _, out = self.run_it("--report")
        self.assertLess(time.time() - start, 3)
        self.assertIn("about 333,000 tokens", out)
        self.assertIn("Setup (first message): about 84,000", out)

    def test_bad_config_uses_the_default(self):
        self.chat(self.folder_of(self.work), "a", [usage_line(100000)])
        for bad in ["{not json", '"a string"', '{"limit": "500k"}', '{"limit": -1}', "[]"]:
            with open(os.path.join(self.skill, "config.json"), "w") as f:
                f.write(bad)
            code, out = self.run_it("--report")
            self.assertEqual(code, 0, bad)
            self.assertIn("(limit 400,000, 25%)", out, bad)

    # ---------- --limit ----------
    def test_limit_formats(self):
        for text, want in [("500000", 500000), ("500,000", 500000), ("500k", 500000), ("500K", 500000),
                           ("0.5m", 500000), ("1m", 1000000), ("10k", 10000), (" 250k ", 250000), ("1_000_000", 1000000)]:
            code, out = self.run_it("--limit", text)
            self.assertEqual(code, 0, text)
            self.assertEqual(self.config()["limit"], want, text)
            self.assertIn(f"-> {want:,} tokens per message", out)

    def test_bad_limits_change_nothing(self):
        self.run_it("--limit", "300k")
        for text in ["abc", "", "5k", "9999", "2m", "-5", "1e6", "500kk", "k", "0"]:
            code, out = self.run_it("--limit", text)
            self.assertEqual(code, 2, text)
            self.assertIn("between 10k and 1m", out)
            self.assertEqual(self.config()["limit"], 300000, text)
        code, _ = self.run_it("--limit")
        self.assertEqual(code, 2)

    def test_limit_keeps_other_settings_and_report_uses_it(self):
        with open(os.path.join(self.skill, "config.json"), "w") as f:
            json.dump({"limit": 400000, "other": True}, f)
        self.run_it("--limit", "200k")
        self.assertEqual(self.config(), {"limit": 200000, "other": True})
        self.chat(self.folder_of(self.work), "a", [usage_line(250000)])
        _, out = self.run_it("--report")
        self.assertIn("(limit 200,000, 125%). Map it with /tongs now", out)

    # ---------- CLAUDE_CODE_AUTO_COMPACT_WINDOW ----------
    def test_auto_compact_window_wins_with_the_meters_70_and_85(self):
        with open(os.path.join(self.skill, "config.json"), "w") as f:
            json.dump({"limit": 900000}, f)  # ignored while the variable is set
        for size, want in [(256899, "69%). Under 70%."), (256900, "70%). Getting big: map it soon with /tongs."),
                           (311949, "84%). Getting big"), (311950, "85%). Map it with /tongs now, then compact.")]:
            self.chat(self.folder_of(self.work), "a", [usage_line(84000), usage_line(size)])
            _, out = self.run_it("--report", auto="400000")  # auto-compacts at 367,000
            self.assertIn(f"about {size:,} tokens (auto-compact at 367,000, {want}", out)

    def test_auto_compact_window_is_read_like_claude_code_reads_it(self):
        self.chat(self.folder_of(self.work), "a", [usage_line(150000)])
        for value, want in [("500000", "auto-compact at 467,000"), ("500k", "auto-compact at 67,000"),
                            ("2000000", "auto-compact at 967,000"), ("abc", "limit 400,000"), ("", "limit 400,000")]:
            _, out = self.run_it("--report", auto=value)
            self.assertIn(f"({want},", out, value)

    def test_limit_says_when_the_variable_overrides_it(self):
        _, out = self.run_it("--limit", "300k", auto="400000")
        self.assertIn("CLAUDE_CODE_AUTO_COMPACT_WINDOW is set, so the meter and /tongs size use where it auto-compacts (about 367,000)", out)
        _, out = self.run_it("--limit", "300k")
        self.assertNotIn("CLAUDE_CODE_AUTO_COMPACT_WINDOW", out)

    def test_no_arguments_prints_help(self):
        code, out = self.run_it()
        self.assertEqual(code, 2)
        self.assertIn("--report", out)
        self.assertIn("--limit", out)


if __name__ == "__main__":
    unittest.main()
