# Phase 6: Ensimmäinen live-testi iPadilla

Tämä ohje on tarkoitettu **testikäyttöön**. Sitä ei ole tarkoitettu tuotantoon,
eikä se kehota mergeämään haaroja tai muuttamaan oletushaaraa.

## Turvallisuusrajat

Älä tee näitä ennen kuin testi on kokonaan valmis ja erikseen hyväksytty:

- älä pushaa muutoksia GitHubiin;
- älä luo Pull Requestia;
- älä mergeä mitään;
- älä muuta oletushaaraa;
- älä käytä tuotantorepositoriota;
- älä anna GitHub Appille laajempia oikeuksia kuin `Contents: Read and write` ja `Metadata: Read-only`;
- älä aseta `SANDBOX_INTERNET=true`, ellei testirepositorio välttämättä tarvitse pakettilatauksia.

Käytä erillistä **testirepositoriota** ja erillistä Cloudflare-testiWorkeria.
Jos Cloudflare ei salli feature-haaraa testiWorkerin production branchina,
tee testi erillisellä haaralla/forkilla tai tietokoneelta. Älä mergeä
feature-haaraa oletushaaraan.

## Mitä tarvitset iPadilla

- Safari
- Telegram-sovellus
- Cloudflare-tili, jossa on **Workers Paid** -plani
- GitHub-tili ja oikeus luoda GitHub App
- Testirepositorio, jossa on vähintään yksi tiedosto
- AI-palvelun API-avain (OpenAI-yhteensopiva tai Anthropic; ei Workers AI)
- Paikka salaisuuksille, esimerkiksi 1Password, Apple Passwords tai muu lukittu holvi

## Vaihe 1: Cloudflare KV ja plan

1. Avaa Safarissa <https://dash.cloudflare.com>.
2. Varmista, että tilillä on **Workers Paid** -plani. Containers ei toimi free-planilla.
3. Valitse **Storage & Databases → KV → Create namespace**.
4. Nimeä namespaceksi `DATABASE`.
5. Kopioi namespace-id talteen. Tarvitset sitä myöhemmin build-muuttujana `DEPLOY_KV_NAMESPACE_ID`.

Älä luo vielä Workeria. Ensin kerätään GitHub- ja Telegram-arvot.

## Vaihe 2: GitHub App testirepositoriolle

1. Avaa Safarissa GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Anna nimi, esimerkiksi `telegram-coding-test`.
3. Poista webhook käytöstä, ellei sinulla ole erillistä webhook-tarvetta.
4. Aseta repository permissions -kohdassa:
   - `Contents`: **Read and write** (tarvitaan hyväksyttyyn branch/commit-kirjoitukseen)
   - `Metadata`: **Read-only** (pakollinen)
   - Älä anna `Administration`, `Pull requests` tai `Workflows` -oikeuksia.
5. Luo App ja kopioi **App ID** talteen.
6. Generoi private key ja lataa `.pem`-tiedosto.
7. Avaa `.pem` Files-sovelluksessa, kopioi koko sisältö salaisuuksien holviin ja poista tiedosto iPadilta, kun se on tallennettu.
8. Asenna App vain testirepositorioon.
9. Etsi asennuksen **installation id** asennuksen URL:sta tai GitHubin asennuslistasta. Kopioi se talteen.

Tärkeää:

- `GITHUB_APP_ID` ja `GITHUB_APP_PRIVATE_KEY` asetetaan aina yhdessä.
- Private key on salaisuus. Sitä ei koskaan laiteta repoon eikä `wrangler.jsonc`-tiedostoon.
- Jos käytät useampaa asennusta, `GITHUB_INSTALLATION_IDS` on JSON-kartta muodossa `{"owner/repo":"123456"}`.

## Vaihe 3: Telegram

1. Avaa Telegram ja aloita keskustelu [@BotFather](https://t.me/BotFather) -botin kanssa.
2. Lähetä `/newbot`, valitse nimi ja käyttäjänimi, joka päättyy `_bot`.
3. Kopioi BotFatherin antama **token** salaisuuksien holviin.
4. Hae oma Telegram-käyttäjätunnuksesi [@userinfobot](https://t.me/userinfobot) -botilta. Tämä on `ADMIN_ID`.
5. Valinnainen: luo erillinen webhook-salaisuus `TELEGRAM_SECRET_TOKEN`. Käytä vain merkkejä `A-Z`, `a-z`, `0-9`, `_` ja `-`. Älä käytä bottitokenia tähän.
6. Älä vielä käynnistä webhookia. Se tehdään vasta, kun Worker on deployed.

## Vaihe 4: Cloudflare-testiWorker

1. Cloudflare-dashboardissa valitse **Workers & Pages → Create → Import a repository**.
2. Yhdistä GitHub ja valitse repositorion fork, jossa tämä haara on.
3. Aseta **Production branch** -kohdaksi `feature/phase-1-tool-calling` testiWorkeria varten. Älä käytä oletushaaraa, jos haluat noudattaa tämän ohjeen rajoja.
4. Jätä **Build command** tyhjäksi. Deploy-komento hoitaa buildin.
5. Aseta **Deploy command** -kohdaksi:

   ```text
   pnpm run deploy:builds
   ```

6. Älä aseta non-production deploy -komennoksi `wrangler deploy` -komentoa samaan testiWorkeriin. Jos Cloudflare pyytää erillisen preview-komennon, käytä mieluummin erillistä testiWorkeria kuin preview'tä, joka ei julkaise container-imagea.
7. Lisää **Settings → Build variables** -kohtaan:
   - `DEPLOY_KV_NAMESPACE_ID`: Vaiheessa 1 kopioitu KV-id.
   - Valinnainen: `DEPLOY_WORKER_NAME`, jos haluat eri Worker-nimen.
   - Valinnainen: `DEPLOY_KV_PREVIEW_NAMESPACE_ID`, jos käytät erillistä preview-KV:tä.
8. Lisää **Settings → Variables and Secrets** -kohtaan seuraavat. Merkitse salaisuudet secreteiksi.

### Bindingit

| Binding | Pakollinen | Tarkoitus |
|---|---|---|
| `DATABASE` | kyllä | KV namespace; `deploy:builds` luo bindingin `DEPLOY_KV_NAMESPACE_ID`:stä. |
| `SANDBOX` | coding | Sandbox-Durable Object; tulee `wrangler.jsonc`:stä. |
| `CODING_SESSION` | coding | Coding-session-Durable Object; tulee `wrangler.jsonc`:stä. |
| `AI` | ei | Workers AI; ei tarvita OpenAI/Anthropic-providerille. |
| `API_GUARD` | ei | Valinnainen webhook-suojaus. |

### Pakolliset perusarvot

| Nimi | Tyyppi | Arvo |
|---|---|---|
| `TELEGRAM_TOKEN` | Secret | BotFatherin token |
| `ADMIN_ID` | Secret tai Variable | oma Telegram-käyttäjänumerosi |

### Coding-käyttöön

| Nimi | Tyyppi | Arvo |
|---|---|---|
| `GITHUB_APP_ID` | Variable | GitHub Appin numeerinen id |
| `GITHUB_APP_PRIVATE_KEY` | Secret | koko `.pem`-sisältö |
| `GITHUB_INSTALLATION_ID` | Variable | asennuksen numeerinen id |
| `GITHUB_ALLOWED_REPOSITORIES` | Variable | vain testirepo, esim. `owner/test-repo` |
| `GITHUB_ALLOWED_REPOSITORIES_BY_USER` | Variable | valinnainen JSON, esim. `{"123456789":["owner/test-repo"]}` |
| `GITHUB_WRITE_ALLOWED_REPOSITORIES` | Variable | vain testirepo, esim. `owner/test-repo` |
| `CODING_APPROVAL_TTL_MS` | Variable | `900000` (15 min) |

### Valinnaiset

| Nimi | Tyyppi | Arvo |
|---|---|---|
| `PUBLIC_BASE_URL` | Variable | `https://<worker>.<subdomain>.workers.dev` vasta deployn jälkeen |
| `TELEGRAM_SECRET_TOKEN` | Secret | valinnainen webhook-salaisuus |
| `ADMIN_PASSWORD` | Secret | valinnainen admin-panel salasana |
| `GITHUB_INSTALLATION_IDS` | Variable | valinnainen JSON usealle asennukselle |
| `GITHUB_API_BASE_URL` | Variable | valinnainen, oletus `https://api.github.com` |
| `SANDBOX_INTERNET` | Variable | **jätä pois tai `false`** ensimmäisessä testissä |

Tärkeää:

- `GITHUB_ALLOWED_REPOSITORIES` on lukuoikeuksien allowlist. Siihen ei saa laittaa `*`-merkkiä.
- `GITHUB_WRITE_ALLOWED_REPOSITORIES` on erillinen kirjoitusallowlist. Ensimmäisessä testissä molemmissa on vain testirepo.
- `SANDBOX_INTERNET` on oletuksena `false`. Älä aseta sitä `true`:ksi, jos testirepo ei tarvitse npm/pip-latauksia.
- AI-palvelun avainta ei laiteta Workerin ympäristömuuttujiin. Se syötetään admin-paneeliin myöhemmin.

## Vaihe 5: Ensimmäinen deploy

1. Käynnistä deploy Cloudflare-dashboardin **Deploy**-painikkeella.
2. Odota buildin valmistumista. Ensimmäinen container-imagen build ja provisioning voivat kestää useita minuutteja.
3. Älä paina deployta uudelleen vain siksi, että container ei vastaa heti. Cloudflare voi näyttää Workerin URL:n ennen kuin container on valmis.
4. Kopioi Workerin URL talteen.
5. Jos build epäonnistuu viestillä, että Docker CLI puuttuu, tarkista että deploy-komento on `pnpm run deploy:builds` ja että kyseessä on production branch -deploy. Workers Builds voi buildata Dockerfilen. Jos se ei onnistu, käytä erillistä konetta, jossa on Docker, tai registry-imagea. iPad ei voi ajaa Docker-daemonia.

## Vaihe 6: Telegram-webhook

1. Avaa Safarissa:

   ```text
   https://<worker>.<subdomain>.workers.dev/init
   ```

2. Tarkista, että vastauksessa näkyy `webhook.ok: true` ja `menuButton.ok: true`.
3. Jos vastaus kertoo `tokenMissing`, `TELEGRAM_TOKEN` puuttuu tai sitä ei ole otettu käyttöön. Lisää secret ja yritä `/init` uudelleen.
4. Avaa Telegram ja lähetä botille `/start`.
5. Lähetä `/admin`. Admin-paneelin pitäisi aueta Telegram Mini Appina.

## Vaihe 7: AI-provideri

1. Avaa `/admin` Telegramissa.
2. Valitse **Chat Providers**.
3. Lisää OpenAI-yhteensopiva tai Anthropic-yhteensopiva provider.
4. Valitse API-formaatiksi `chat-completions` tai `anthropic-messages`.
5. Lisää malli ja aseta se oletukseksi.
6. Älä valitse Cloudflare Workers AI -provideria coding-käyttöön; se ei tue tool-calling-loopia.
7. Tallenna asetukset.

## Vaihe 8: Perussmoke-testi

1. Lähetä botille `/new`.
2. Lähetä lyhyt viesti, esimerkiksi `Vastaa yhdellä lauseella: testi toimii.`
3. Varmista, että botti vastaa.
4. Lähetä `/code_status`. Ilman aktiivista sessiota vastauksen pitäisi olla selkeä “no active session” -viesti.
5. Lähetä `/code`. Testirepon pitäisi näkyä valittavana.

## Vaihe 9: Coding-testi ja hyväksyntä

1. Lähetä `/code` ja valitse testirepo.
2. Odota, että checkout valmistuu.
3. Lähetä pieni tehtävä, esimerkiksi:

   ```text
   Lisää README.md-tiedostoon yksi lyhyt rivi "Tested by Telegram coding agent." ja näytä git diff.
   ```

4. Odota, että botti lähettää muutosten yhteenvedon ja hyväksyntäpainikkeet.
5. Paina **Review changes** ja tarkista koko diff.
6. Varmista, että diffissä ei ole salaisuuksia eikä odottamattomia tiedostoja.
7. Paina **Approve and save to GitHub**.
8. Varmista Telegramista, että hyväksyntä onnistui ja että viesti kertoo branchin ja commitin.
9. Avaa GitHub Safarissa ja tarkista:
   - uusi branch `telegram-agent/...` on syntynyt;
   - commit sisältää vain hyväksytyn muutoksen;
   - oletushaara ei ole muuttunut;
   - Pull Requestia ei syntynyt.
10. Testaa erikseen **Reject changes** toisella pienellä muutoksella. Varmista, että GitHubiin ei synny uutta branchia eikä committia.

## Vaihe 10: Lopetus ja siivous

1. Lähetä `/code_stop`, jos sessio on vielä auki.
2. Älä poista testiWorkeria ennen kuin olet tallentanut havainnot.
3. Jos poistat testiWorkerin, poista myös testiKV vasta, kun et enää tarvitse sitä.
4. Poista GitHub Appin asennus testireposta, kun testi on valmis.
5. Poista `.pem`-tiedosto iPadin Files-sovelluksesta, jos se on vielä siellä.

## Hyväksymiskriteerit

Testi on onnistunut, kun kaikki nämä ovat totta:

- [ ] Worker vastaa ja `/init` palauttaa `webhook.ok: true`.
- [ ] Telegramin perusviesti toimii.
- [ ] `/code` listaa vain testirepon.
- [ ] Coding-agentti tekee muutoksen sandboxissa, ei suoraan GitHubiin.
- [ ] Hyväksyntäviesti näyttää koko diffin tai lähettää sen dokumenttina.
- [ ] Hyväksyntä luo uuden branchin ja commitin, ei muuta oletushaaraa.
- [ ] Hylkäys ei kirjoita GitHubiin.
- [ ] `SANDBOX_INTERNET` on pois päältä tai `false`.
- [ ] GitHub Appilla ei ole ylimääräisiä oikeuksia.
- [ ] Repoon ei ole päätynyt salaisuuksia.

## Yleisimmät virheet

| Oire | Tarkista |
|---|---|
| `Docker CLI is needed` | Käytä Workers Builds -production-deployta (`pnpm run deploy:builds`) tai konetta, jossa Docker toimii. |
| `No container is configured` | Worker ei saanut Containers/Durable Object -konfiguraatiota; käytä Option B/C -deployta, älä copy/paste-Option D:tä. |
| `TELEGRAM_TOKEN is not set` | Lisää secret ja avaa `/init` uudelleen. |
| `No chat model is configured` | Lisää AI-provideri admin-paneelissa ja aseta oletusmalli. |
| `Coding sessions require a chat provider that supports tool calling` | Vaihda OpenAI-yhteensopivaan tai Anthropic-provideriin. |
| `Repository is not authorized` | Tarkista `GITHUB_ALLOWED_REPOSITORIES` ja että kirjoitat repositorion omistaja/nimi oikein. |
| `GitHub App write credentials are not configured` | Tarkista `GITHUB_APP_ID`, private key ja `Contents: Read and write`. |
| `The base branch changed after the change set was approved` | Branch liikkui hyväksynnän jälkeen. Aloita uusi instruktio; älä yritä ohittaa tarkistusta. |
| Approval on `expired` tai `stale` | Hyväksyntä vanheni tai diff muuttui. Aloita uusi instruktio. |
| Container ei vastaa heti | Odota provisioningia useita minuutteja ja tarkista Cloudflare-lokit. |

## Ensimmäinen konkreettinen askel

Avaa iPadin Safarissa Cloudflare-dashboard, varmista **Workers Paid** -plani ja
luo `DATABASE`-niminen KV-namespace. Kopioi sen id talteen
`DEPLOY_KV_NAMESPACE_ID`-build-muuttujaa varten.
