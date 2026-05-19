from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0036_program_entity_and_membership"),
    ]

    operations = [
        migrations.AddField(
            model_name="sprint",
            name="capacity_points",
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="historicalsprint",
            name="capacity_points",
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
    ]
