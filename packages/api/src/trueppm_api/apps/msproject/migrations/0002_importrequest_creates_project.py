from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("msproject", "0001_import_request"),
    ]

    operations = [
        migrations.AddField(
            model_name="importrequest",
            name="creates_project",
            field=models.BooleanField(default=False),
        ),
    ]
