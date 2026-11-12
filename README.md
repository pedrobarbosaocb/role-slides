# 🛹 Rolê de Slides

Inscrição nos horários de apresentação do rolê — **sábado, 14/11/2026, a partir das 12h** (countdown no topo da página).

- 16 vagas em 3 blocos (14h–16h, 16h–18h, 20h–22h); as vagas diminuem ao vivo para todo mundo.
- Quem se inscreve pode **editar ou cancelar** só a própria inscrição (vale no mesmo navegador: a chave fica no `localStorage`; o banco confere o hash).
- **Modo Organizador** (com PIN): reordenar, remover e resetar.
- Botão para copiar o cronograma formatado para o WhatsApp.

## Deploy: GitHub Pages + Supabase (igual ao moodboard)

Site estático (`index.html` + `app.js`); o workflow gera `config.js` com as variáveis do repositório.
Os dados ficam no schema privado `rs` do Supabase, fora da API REST; o front só usa a chave pública (`anon`) e chama as funções RPC `rs_*`, que conferem capacidade do bloco (com lock), chave de cancelamento e PIN (8 erros em 10 min bloqueiam o IP). O tempo real usa Realtime Broadcast (canal `role-slides`), com recarga a cada 30 s como reserva.

1. No **SQL Editor** do projeto Supabase, rode os arquivos de `supabase/migrations/` em ordem (`0001`, `0002`; são idempotentes).
2. Defina o PIN do organizador (4 a 8 dígitos):
   ```sql
   insert into rs.config values ('organizer_pin', '1234')
   on conflict (key) do update set value = excluded.value;
   ```
3. Variáveis do repositório (*Settings → Secrets and variables → Actions → Variables*): `SUPABASE_URL` e `SUPABASE_ANON_KEY`.
4. *Settings → Pages → Source: GitHub Actions*. Todo push na `main` publica.

Sem as variáveis, o site roda em **modo local** (dados só no navegador, sem PIN).

Para mudar blocos/vagas: `BLOCKS_CONFIG` em `app.js` **e** a tabela `rs.blocks` (o banco é quem garante a capacidade).

## Rodando local

```bash
npx serve .    # ou qualquer servidor estático
```
