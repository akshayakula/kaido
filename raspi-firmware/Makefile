# raspi-firmware deploy + ops helpers.
#
#   make deploy          # push main.py + ring.py to PI_HOST and restart firmware
#   make deploy PI=load1 # same, against the load1 host
#   make logs            # tail the firmware journal
#   make restart         # systemctl restart firmware (no file push)
#   make status          # systemctl status firmware
#   make verify          # confirm deployed file matches local checksum
#
# Per-Pi hosts live in this Makefile (override via PI=<key> on the cli).
# Anyone with passwordless ssh from raspi-firmware/OPERATIONS.md can run these.

PI            ?= sensor1
PI_HOST_sensor1 ?= pi-sensor1@192.168.1.14

PI_HOST = $(PI_HOST_$(PI))
ifeq ($(PI_HOST),)
$(error No host defined for PI=$(PI). Add PI_HOST_$(PI) at the top of the Makefile.)
endif

DEST = /usr/local/lib/raspi-firmware
SRC  = main.py ring.py

SSH := ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no
SCP := scp -o ConnectTimeout=5 -o StrictHostKeyChecking=no

.PHONY: deploy logs restart status verify diff

deploy:
	@echo "▶ pushing $(SRC) to $(PI_HOST):$(DEST)"
	$(SCP) $(SRC) $(PI_HOST):/tmp/
	$(SSH) $(PI_HOST) ' \
	  set -e; \
	  for f in $(SRC); do \
	    sudo install -m 644 -o root -g root /tmp/$$f $(DEST)/$$f; \
	    rm -f /tmp/$$f; \
	  done; \
	  sudo systemctl restart firmware; \
	'
	@echo "▶ restarted firmware.service · tailing 5 lines"
	@$(SSH) $(PI_HOST) 'sleep 1 && sudo journalctl -u firmware -n 5 --no-pager'

logs:
	$(SSH) -t $(PI_HOST) 'sudo journalctl -u firmware -f -n 40'

restart:
	$(SSH) $(PI_HOST) 'sudo systemctl restart firmware'
	@$(SSH) $(PI_HOST) 'sleep 1 && sudo systemctl status firmware --no-pager -l | head -12'

status:
	@$(SSH) $(PI_HOST) 'sudo systemctl status firmware --no-pager -l | head -20'

verify:
	@echo "▶ checksum compare (local vs $(PI_HOST):$(DEST))"
	@for f in $(SRC); do \
	  l=$$(shasum -a 256 $$f | awk '{print $$1}'); \
	  r=$$($(SSH) $(PI_HOST) "sha256sum $(DEST)/$$f 2>/dev/null | awk '{print \$$1}'"); \
	  if [ "$$l" = "$$r" ]; then echo "  ✓ $$f"; \
	  else echo "  ✗ $$f differs (local=$$l remote=$$r)"; fi; \
	done

diff:
	@for f in $(SRC); do \
	  echo "▶ diff $$f"; \
	  $(SSH) $(PI_HOST) "cat $(DEST)/$$f" 2>/dev/null | diff -u - $$f || true; \
	done
