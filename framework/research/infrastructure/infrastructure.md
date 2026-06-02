

Provisioning - Terraform (hetznercloud/hcloud provider)

server
volumes
networks
firewalls
load balancer
SSH keys
etc

State management
- Hetzner Object Storage


Project Structure & Reusability
- Terraform modules to encapsulate reusable infrastructure patterns



Server Configuration & Provisioning
- cloud-init is the cleanest first-boot mechanism. Pass a user_data script to bootstrap users, SSH hardening, package installation, and pull subsequent configuration.


Networking & Security Best Practices

Use Hetzner private networks to keep internal traffic off the public internet. Combine with Hetzner Cloud Firewalls (managed via Terraform) rather than relying solely on host-level firewalls.


Standard hardening:

SSH keys only, no passwords; manage keys via the hcloud_ssh_key resource
Use Hetzner Load Balancers for ingress and TLS termination

