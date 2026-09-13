"""Hardened Django admin site — off by default, defended when on (#3557).

``urls.py`` mounts ``admin.site.urls`` at ``/admin/``, which made ``/admin/login/``
a **second password door** onto the same account store as
``POST /api/v1/auth/token/`` — carrying none of the first door's controls:

* **No throttle.** DRF throttles run from ``APIView.check_throttles``. The admin
  login is a plain Django view, so neither the IP-keyed ``login`` scope (#770)
  nor the per-account ``login_account`` lockout (#1717) ever saw a request to it.
* **No audit line.** ``auth.login_failed`` and ``auth.login_succeeded``
  (ADR-1120) are emitted by our own login view, so an operator alarming on
  credential-stuffing bursts was blind to every attempt against this door.
* **Outside the enterprise seam.** ``local_login_allowed`` (ADR-0187 §4) is what
  "enforced org-wide SSO / disable local accounts" hangs off. An account an
  enterprise policy had blocked from password sign-in could still log in here.

And the door is not a hypothetical one: the ``create_admin`` bootstrap creates a
superuser on first deploy, so an exposed ``/admin/`` is an unthrottled,
unrecorded guessing surface against a *known-present* privileged account.

The two halves of the fix are independent and both ship:

1. **Off unless asked for** (``TRUEPPM_DJANGO_ADMIN_ENABLED``, default ``False``
   outside ``settings/dev.py``). Every ``/admin/`` path answers ``404`` — not
   ``403``, so the surface is not even advertised. This is the primary control,
   because the strongest statement about a surface almost nobody uses is that it
   is not there.
2. **Hardened when it is asked for.** An operator who turns it on gets the same
   two throttle buckets, the same two audit lines, and the same policy seam as
   the API login — not the bare Django view. Half a fix here would be the worse
   outcome of the two: "I enabled admin access" is a deliberate act, and it must
   not silently re-open everything the first half closed.

The chart's nginx ``/admin/`` deny (``web.adminAccess``) is unchanged and still
correct — it is an edge control, and Docker Compose and bare-metal deploys route
to the API directly with no such edge. This is the defense that travels with the
application instead of with one deployment topology.
"""

from __future__ import annotations

from collections.abc import Callable
from functools import update_wrapper
from typing import TYPE_CHECKING, Any, TypeVar, cast

from django.conf import settings
from django.contrib import admin
from django.contrib.admin.apps import AdminConfig
from django.contrib.auth import logout as auth_logout
from django.http import Http404, HttpResponse, HttpResponseBase, HttpResponseForbidden
from django.utils.decorators import method_decorator
from django.views.decorators.cache import never_cache

if TYPE_CHECKING:
    from django.http import HttpRequest

#: Mirrors django-stubs' own ``AdminSite.admin_view`` signature, which is generic in
#: the view callable so the decorated view keeps its exact type. Re-declaring it here
#: is what lets the override below stay signature-compatible with the supertype.
_ViewT = TypeVar("_ViewT", bound=Callable[..., HttpResponseBase])


def django_admin_enabled() -> bool:
    """Whether ``/admin/`` answers at all on this deployment.

    Read per request rather than captured at URLconf import, so the URL tree is
    the same shape either way and the setting is what decides — which is also
    what lets a test flip it with ``override_settings`` instead of reloading the
    root URLconf. ``getattr`` with a ``False`` fallback keeps a settings module
    that predates the flag closed rather than open.
    """
    return bool(getattr(settings, "DJANGO_ADMIN_ENABLED", False))


class HardenedAdminSite(admin.AdminSite):
    """``AdminSite`` that 404s when disabled and defends its login when enabled.

    Installed as the project's default admin site through :class:`HardenedAdminConfig`,
    so ``admin.site`` *is* this class everywhere — there is no second, unguarded
    site object for a stray ``admin.site.urls`` to mount.
    """

    def admin_view(self, view: _ViewT, cacheable: bool = False) -> _ViewT:
        """Wrap every admin view so a disabled deployment answers ``404``.

        ``admin_view`` is the single chokepoint Django routes admin views through:
        :meth:`AdminSite.get_urls` wraps its own views with it, and every
        ``ModelAdmin.get_urls`` wraps *its* views with ``self.admin_site.admin_view``.
        Guarding here therefore covers the index, the app indexes, every model
        changelist/add/change/delete/history page, ``jsi18n``, autocomplete, and the
        final catch-all — including any ``ModelAdmin`` a future app registers, which
        an explicit per-URL list would silently miss.

        ``login`` is the one admin view Django does **not** route through
        ``admin_view`` (it must be reachable unauthenticated), which is why
        :meth:`login` repeats the check rather than relying on this.

        The guard is the *outer* wrapper: a disabled deployment must 404 before the
        inner "not logged in → redirect to the login page" behavior can hand back a
        redirect that advertises a door which is not there.
        """
        inner = super().admin_view(view, cacheable)

        def wrapper(request: HttpRequest, *args: Any, **kwargs: Any) -> HttpResponseBase:
            if not django_admin_enabled():
                raise Http404("Django admin is disabled on this deployment.")
            return inner(request, *args, **kwargs)

        return cast("_ViewT", update_wrapper(wrapper, view))

    @method_decorator(never_cache)
    def login(
        self, request: HttpRequest, extra_context: dict[str, Any] | None = None
    ) -> HttpResponse:
        """Admin login, carrying the API login's throttles, audit lines and policy seam.

        The order below is the security property, not house style:

        1. **Disabled → 404**, before anything else. Not ``403``: a ``403`` confirms
           the path exists.
        2. **Throttle before authenticating**, IP bucket first and account bucket
           second, mirroring ``CookieTokenObtainPairView``'s
           ``throttle_classes = [ScopedRateThrottle, LoginAccountRateThrottle]`` —
           including DRF's short-circuit, where a denial by the first throttle
           leaves the second uncharged. Both are the *same buckets* the API login
           uses (see ``LoginIpRateThrottle``), so the two doors share one allowance
           and an attacker cannot spend one and then start fresh on the other.
        3. **Consult the enterprise seam after credentials validate, never before.**
           Checking it earlier would answer "does this account exist and is it
           SSO-only?" to an unauthenticated caller. On a refusal the session Django
           has just established is torn down again — ``LoginView`` calls
           ``auth_login`` inside ``form_valid``, so by the time we see the response
           the cookie exists, and a 403 body over a live session would be a refusal
           in name only.
        4. **Emit ``auth.login_succeeded`` last**, after the seam (ADR-1120). A line
           emitted where credentials validated would report a success for a login
           the seam still refuses.

        Success is read off the response status, not off ``request.user``:
        ``LoginView`` redirects on success and re-renders the form (``200``) on
        failure, whereas ``request.user`` is already populated for anyone who
        arrives with a live session and would report a *failed* re-login as a
        success.
        """
        if not django_admin_enabled():
            raise Http404("Django admin is disabled on this deployment.")
        if request.method != "POST":
            return super().login(request, extra_context)

        # Lazy imports: this module is imported during ``apps.populate()`` as an app
        # config, before the model registry is ready — and ``core.auth_views`` binds
        # ``get_user_model()`` at module scope.
        from trueppm_api.core.auth_views import emit_login_failure, emit_login_success
        from trueppm_api.core.throttling import LoginAccountRateThrottle, LoginIpRateThrottle

        identifier = str(request.POST.get("username") or "").strip()

        wait = LoginIpRateThrottle.consume(request)
        if wait is None and identifier:
            # No identifier → no account bucket to charge, exactly as
            # ``LoginAccountRateThrottle.get_cache_key`` decides for the API login.
            wait = LoginAccountRateThrottle.consume(identifier)
        if wait is not None:
            emit_login_failure(request, identifier=identifier or None)
            response = HttpResponse(
                "Too many login attempts. Try again later.",
                status=429,
                content_type="text/plain",
            )
            response["Retry-After"] = str(int(wait) + 1)
            return response

        response = super().login(request, extra_context)

        if response.status_code not in (301, 302):
            emit_login_failure(request, identifier=identifier or None)
            return response

        user = getattr(request, "user", None)
        if user is None or not user.is_authenticated:
            # A redirect with no authenticated user is not a login (the "already
            # signed in, go to the index" path). Nothing happened worth recording.
            return response

        from trueppm_api.apps.sso.extensions import local_login_allowed

        if not local_login_allowed(user):
            auth_logout(request)
            return HttpResponseForbidden(
                "Password sign-in is disabled for this account. Use single sign-on.",
                content_type="text/plain",
            )

        emit_login_success(request, user=user, method="admin", remember=False)
        return response


class HardenedAdminConfig(AdminConfig):
    """Replaces ``django.contrib.admin`` in ``INSTALLED_APPS`` to swap the default site.

    Django's documented hook for using a custom ``AdminSite`` project-wide. The app
    itself — its label, models, migrations and ``autodiscover`` behavior — is
    unchanged; only which class ``admin.site`` resolves to differs.
    """

    default_site = "trueppm_api.core.admin_site.HardenedAdminSite"
