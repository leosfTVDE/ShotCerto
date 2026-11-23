// ===== ShotCerto — configuração =====
// Este é o ÚNICO ficheiro que precisa de editar.
// Enquanto "firebase" estiver null, o app funciona em MODO DEMONSTRAÇÃO
// (tudo fica só no próprio celular e a IA é simulada).

window.SC_CONFIG = {
  // 1) Cole aqui o firebaseConfig do projeto Firebase do ShotCerto
  //    (Firebase > Configurações do projeto > Seus apps > Configuração do SDK).
  //    Exemplo:
  //    firebase: { apiKey: "...", authDomain: "...", projectId: "...", storageBucket: "...", messagingSenderId: "...", appId: "..." },
  firebase: null,

  // 2) Endereço do servidor da IA (Cloudflare Worker), ex.: "https://shotcerto-api.seunome.workers.dev"
  //    Vazio = IA simulada.
  workerUrl: "",

  // 3) Links de pagamento (Hotmart ou Kiwify) de cada plano
  checkout: {
    mensal: "",
    anual: "",
    vitalicio: ""
  },

  // 4) Preços que aparecem no app (só texto)
  precos: {
    mensal: "R$ 19,90",
    anual: "R$ 147",
    vitalicio: "R$ 67"
  },

  // 5) Emails com acesso total (você e quem vai testar). Separe por vírgulas.
  admins: ["leonardospinasse@gmail.com"],

  // 6) WhatsApp de suporte (só números, com DDI), ex.: "351969698927". Vazio = esconde o botão.
  suporteWhatsapp: ""
};
