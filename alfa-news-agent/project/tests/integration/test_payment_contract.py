"""Use the same canonical producer fixtures/adversarial mutations as Node."""
import copy
import json
import unittest
from jsonschema import ValidationError

from integration.contracts import validate, ROOT

CASES = json.loads((ROOT / "tests/fixtures/payment_contract_cases.json").read_text(encoding="utf-8"))


class PaymentContractTests(unittest.TestCase):
    def test_profiles_accept_new_block_missing_source_zero_flow_and_old_snapshot(self):
        for name, profile in CASES["profiles"].items():
            with self.subTest(name=name):
                validate("Profile", profile)
                old = copy.deepcopy(profile)
                del old["payment_summary"]["counterparty_context"]
                old["provenance"]["signal_method"] = "deterministic_rules_v1"
                validate("Profile", old)

    def test_shared_invalid_vectors_fail_at_service_boundary(self):
        for mutation in CASES["invalid_mutations"]:
            with self.subTest(name=mutation["name"]):
                profile = copy.deepcopy(CASES["profiles"][mutation["profile"]])
                for patch in mutation.get("patches", [mutation]):
                    parts = patch["path"].strip("/").split("/")
                    target = profile
                    for key in parts[:-1]:
                        target = target[int(key)] if isinstance(target, list) else target[key]
                    target[int(parts[-1]) if isinstance(target, list) else parts[-1]] = patch["value"]
                with self.assertRaises(ValidationError):
                    validate("Profile", profile)

    def test_rounding_tolerance_does_not_require_binary_float_identity(self):
        profile = copy.deepcopy(CASES["profiles"]["available"])
        profile["payment_summary"]["counterparty_context"]["out"]["coverage"]["industry"]["known_amount"] += 1e-12
        validate("Profile", profile)

    def test_frozen_shared_example_is_still_valid(self):
        validate("ProfileResponse", json.loads((ROOT / "contracts/v1/examples/profile-response.json").read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
