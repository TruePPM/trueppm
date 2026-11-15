from typing import Any

from django.db import migrations


def _retire_inbound_summary_links(apps: Any, schema_editor: Any) -> None:
    """Delegate to the tested repair function (rationale lives there)."""
    from trueppm_api.apps.projects.summary_link_repair import retire_inbound_summary_links

    retire_inbound_summary_links(
        apps.get_model("projects", "Dependency"),
        apps.get_model("projects", "Task"),
        apps.get_model("projects", "Project"),
    )


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0172_export_job_file_sha256"),
    ]

    operations = [
        # Not elidable: a squash must keep this data step (test_squash_data_op_parity).
        # Reverse is a noop: the retired links were refused by the engine and are not
        # worth reviving.
        migrations.RunPython(_retire_inbound_summary_links, migrations.RunPython.noop),
    ]
