# Prochains bus (SIRI-SM 2.8)

Un écran : on tape un numéro de station et on voit les bus attendus dans les 30 prochaines minutes (rafraîchi toutes les 30 s).
Node ≥ 20.6 et la commande `unzip`, aucune dépendance npm.

Les noms de stations viennent du GTFS du ministère : `stops.js` le télécharge au démarrage puis une fois par jour, et garde seulement `data/stops.json` (~2,5 Mo).

- `server.js` : sert l'interface + `/api/arrivals?stop=XXXXX` (proxy vers l'API du ministère, la clé reste côté serveur)
- `public/index.html` : l'interface (`?stops=32902,32901` dans l'URL pour mettre la tablette en favori ; on ajoute/supprime des stations depuis l'écran)

## En local
```bash
npm run dev            # fausses données, http://localhost:3000 (mot de passe : dev)
cp .env.example .env   # remplir MOT_KEY et APP_PASSWORD
npm start              # vraies données (seulement depuis une IP autorisée par le ministère)
```

## Sur le serveur Hetzner
```bash
# depuis ton Mac
rsync -av --exclude .env --exclude node_modules ./ root@IP_HETZNER:/opt/bus-arrivals/

# sur le serveur
apt install -y unzip
mkdir -p /opt/bus-arrivals/data && chown www-data /opt/bus-arrivals/data
cd /opt/bus-arrivals && cp .env.example .env && nano .env   # remplir MOT_KEY et APP_PASSWORD
cp deploy/bus-arrivals.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now bus-arrivals
curl "localhost:3000/api/arrivals?stop=32902"               # test
journalctl -u bus-arrivals -f                               # logs en direct
journalctl -u bus-arrivals --since today | grep ERROR       # erreurs API du jour
```
L'IP publique du serveur Hetzner doit être déclarée au ministère (ptsupport@mot.gov.il).
