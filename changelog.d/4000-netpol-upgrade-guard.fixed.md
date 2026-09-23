- Upgrading the Helm chart from `0.4.0-beta.3` or earlier no longer silently cuts off all traffic on
  clusters whose ingress controller isn't in an `ingress-nginx` namespace (k3s, RKE2, cloud load
  balancers). The upgrade that first adds the `api`/`web` default-deny ingress NetworkPolicies now
  refuses to render until you confirm or set `networkPolicy.ingressControllerSelector`. On k3s and
  RKE2, the default also admits `kube-system`, where their bundled controllers run. The selector is
  now rendered verbatim, so an `ipBlock` peer works, and an empty selector refuses to render instead
  of admitting every source (#4000).

  **Known issue (#4003):** the new web-pod policy also blocks two ways of exposing the site that the
  chart itself documents: a Cloudflare Tunnel (or other tunnel) pointed at the web Service, which is
  the documented way to expose the demo, and `web.service.type: LoadBalancer`/`NodePort`. On a CNI
  that enforces NetworkPolicy, such an install is unreachable even though every pod is Ready and
  `helm test` passes, and a **fresh** install gets no warning. Until #4003 ships, set
  `networkPolicy.ingressControllerSelector` to the namespace your tunnel runs in (for example
  `--set-json
  'networkPolicy.ingressControllerSelector={"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"cloudflared"}},"podSelector":{}}'`),
  use an `ipBlock` peer for LoadBalancer/NodePort sources, or set `networkPolicy.enabled=false`.
  Check the public URL after installing or upgrading.
