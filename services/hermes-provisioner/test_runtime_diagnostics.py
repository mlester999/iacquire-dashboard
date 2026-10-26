from __future__ import annotations

import unittest

from safe_runtime_diagnostics import classify_runtime_log


class SafeRuntimeDiagnosticsTests(unittest.TestCase):
    def test_classifies_denied_operation_and_only_path_root(self):
        codes = classify_runtime_log(
            "usermod: cannot lock /etc/passwd; Permission denied."
        )

        self.assertIn("permission_denied", codes)
        self.assertIn("permission_denied_command_usermod", codes)
        self.assertIn("permission_denied_path_etc", codes)
        self.assertNotIn("/etc/passwd", ",".join(codes))

    def test_classifies_readonly_write_without_echoing_client_path(self):
        codes = classify_runtime_log(
            "mkdir: cannot create directory '/opt/data/profiles/client-42': "
            "Read-only file system"
        )

        self.assertIn("read_only_write", codes)
        self.assertIn("read_only_write_command_mkdir", codes)
        self.assertIn("read_only_write_path_opt_data", codes)
        self.assertNotIn("client-42", ",".join(codes))
        self.assertNotIn("/opt/data/profiles", ",".join(codes))

    def test_classifies_safe_run_subtree_without_echoing_full_path(self):
        codes = classify_runtime_log(
            "printf: cannot create '/run/s6/container_environment/KEY': "
            "Permission denied"
        )

        self.assertIn("permission_denied_path_run", codes)
        self.assertIn("permission_denied_path_run_s6", codes)
        self.assertIn("permission_denied_path_run_s6_container_environment", codes)
        self.assertNotIn("/run/s6/container_environment/KEY", ",".join(codes))

    def test_preserves_runtime_secret_codes_without_echoing_other_log_text(self):
        codes = classify_runtime_log(
            "Hermes client runtime stopped: api_key_secret_unavailable\n"
            "Hermes client runtime stopped: private-token-value\n"
            "private-token-value=abc123"
        )

        self.assertIn("api_key_secret_unavailable", codes)
        self.assertNotIn("private-token-value", ",".join(codes))
        self.assertNotIn("abc123", ",".join(codes))

    def test_unknown_permission_errors_remain_nonempty_and_safe(self):
        codes = classify_runtime_log(
            "some-new-service failed with PermissionError for private/path/value"
        )

        self.assertIn("permission_denied", codes)
        self.assertNotIn("private/path/value", ",".join(codes))


if __name__ == "__main__":
    unittest.main()
