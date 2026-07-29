# Idempotent GlitchTip first-login provisioner. Run via `manage.py shell -c` in a
# one-off web container (DB access regardless of web's run-mode). Creds come from
# the container env (GT_* passed with -e, kept out of the env file + logs).
# get_or_create the superuser, force staff/superuser/active, (re)set the vaulted
# password, then get_or_create the org and add the user as OWNER (add_user
# auto-creates the OrganizationOwner for the first user). Prints CHANGED on any
# mutation, else NOCHANGE (NOT "UNCHANGED" — that contains "CHANGED" as a
# substring and would always match the task's changed_when).
import os
from django.contrib.auth import get_user_model
from apps.organizations_ext.models import Organization, OrganizationUserRole
U = get_user_model()
email = os.environ['GT_ADMIN_EMAIL']
pw = os.environ['GT_ADMIN_PASSWORD']
orgname = os.environ['GT_ORG_NAME']
changed = False
u, created = U.objects.get_or_create(email=email)
changed = changed or created
if not (u.is_staff and u.is_superuser and u.is_active):
    u.is_staff = u.is_superuser = u.is_active = True
    changed = True
if not u.check_password(pw):
    u.set_password(pw)
    changed = True
u.save()
org, oc = Organization.objects.get_or_create(name=orgname)
changed = changed or oc
if not org.users.filter(pk=u.pk).exists():
    org.add_user(u, OrganizationUserRole.OWNER)
    changed = True
print('CHANGED' if changed else 'NOCHANGE')
