export interface FaqItem {
  q: string;
  a: string[];
  table?: [string, string][];
}
export interface FaqDict {
  h1: string;
  lede: string;
  search: string;
  none: string;
  groups: { h: string; items: FaqItem[] }[];
}

export const faqEn: FaqDict = {
  h1: "Questions",
  lede: "What people ask before they trade on Jangteo. If yours isn't here, ask us on X or Discord.",
  search: "Search the questions",
  none: "Nothing matches. Try another word.",
  groups: [
    {
      h: "Getting started",
      items: [
        {
          q: "What is Jangteo?",
          a: [
            "Jangteo, Korean for a market square, is a set of stalls on GIWA, Upbit's Ethereum layer 2: savings circles, token offerings, a premarket, a launchpad called Ppeongtwigi, an NFT market called Insadong, a DEX with an aggregator across every GIWA exchange, limit orders and DCA, a bridge, and a points season.",
            "Everything runs on GIWA Sepolia, the testnet. Test ETH and test won have no value.",
          ],
        },
        {
          q: "Which wallet do I need, and how do I add GIWA?",
          a: [
            "Any browser wallet that works with Ethereum (MetaMask, Rabby, OKX and similar). When you connect, Jangteo asks your wallet to add GIWA Sepolia (chain 91342) for you.",
          ],
        },
        {
          q: "How do I get test ETH on GIWA?",
          a: [
            "Bridge Sepolia ETH from Ethereum on the Swap page's Bridge tab (it arrives in one to three minutes), or use GIWA's own faucet. Sepolia ETH itself comes from any Sepolia faucet.",
          ],
        },
        {
          q: "What is Dojang verification and why do some stalls need it?",
          a: [
            "Dojang is GIWA's on-chain identity attestation. One verified person can hold one verified wallet, so stalls that pay per person (offering allocations, circles, yut, launching a token, the points ranking) use it to stop one person from acting as many.",
            "Trading, swapping and bridging are open to every wallet.",
          ],
        },
      ],
    },
    {
      h: "Fees",
      items: [
        {
          q: "What does Jangteo charge?",
          a: ["Every fee is set in the contracts and capped there. They are shown before you sign."],
          table: [
            ["Jangteo Swap", "0.3% per swap: 0.25% to liquidity providers, 0.05% to Jangteo"],
            ["Aggregator", "0.1% on routes through other GIWA DEXes; none inside Jangteo Swap"],
            ["Limit orders / DCA", "0.1% of each fill"],
            ["Ppeongtwigi", "1% of each curve trade (half to the token's creator) and 1% at graduation"],
            ["Insadong mints", "0.5% of mint income, paid by the creator; free mints pay nothing"],
            ["Insadong sales", "0.5% of the price (from 28 September 2026; 2% before), plus the royalty the creator set (up to 10%)"],
            ["Bridge to GIWA", "0.5%"],
            ["Withdraw to Ethereum", "0.5% (7 days), or fast: 1% + 0.0005 ETH (minutes)"],
            ["Offerings", "2% of what is raised"],
            ["Premarket", "2% of the payment, only when a trade completes"],
            ["Listings (prediction markets)", "1%"],
            ["Circles", "1% of each pot"],
            ["Yut", "3% of the pot"],
          ],
        },
      ],
    },
    {
      h: "Trading",
      items: [
        {
          q: "Where do swaps get their price?",
          a: [
            "Jangteo Swap is Uniswap V2 exactly as Uniswap published it. The aggregator also quotes every pool on GIWA's other DEXes (Uniswap V2/V3 forks, Naruswap, KachiSwap and more) and fills through whichever route pays you the most, with your minimum enforced on-chain.",
          ],
        },
        {
          q: "How do limit orders and DCA work?",
          a: [
            "Your funds wait in the order contract. Jangteo's keeper fills a limit order as soon as the market reaches your price, and a DCA order on its schedule, always through the aggregator and never below the rate you set. The output goes straight to your wallet.",
            "You can cancel at any time and the rest comes back at once. Only an announced keeper can fill orders, and a new keeper can only start 48 hours after it is announced, so you always have time to cancel.",
          ],
        },
        {
          q: "What is the order book on the trade page?",
          a: [
            "It shows open limit orders on Jangteo together with the pools' own depth around the market price. Click any level to place a limit order at that price.",
          ],
        },
      ],
    },
    {
      h: "Ppeongtwigi (launchpad)",
      items: [
        {
          q: "How does a launch work?",
          a: [
            "A verified creator launches a token on a bonding curve: every buy raises the price. When the curve holds 4.2 ETH the token pops (graduates): the curve closes and the token opens on Jangteo Swap at exactly the curve's last price, with its liquidity locked forever.",
            "Anyone can buy and sell on the curve, including other apps and bots through the Ppeongtwigi router.",
          ],
        },
        {
          q: "Can a creator dump on buyers?",
          a: [
            "A creator's first buy is capped, the supply is fixed when the token is made, and graduation liquidity is locked in the pool for good. Tokens can still lose value, like anything that trades.",
          ],
        },
      ],
    },
    {
      h: "Insadong (NFTs)",
      items: [
        {
          q: "What is Tal and how do I get one?",
          a: [
            "Tal is Jangteo's own collection: 1,000 Korean masks drawn entirely on-chain. The mint opens with a whitelist event, then a public sale. Dates, prices and how to join the whitelist are announced first on Jangteo's X and Discord.",
            "Pictures and traits stay hidden until the reveal, which uses a block hash nobody knows while the mint runs. Holders get 10% more Jangteo points.",
          ],
        },
        {
          q: "Is my NFT safe while it is listed?",
          a: [
            "It stays in your wallet. Listing only lets the market move it at the moment someone pays your exact price. If you move or sell it elsewhere, the old listing simply can no longer be bought.",
            "An offer's ETH sits in the market contract until you accept it or the buyer cancels; the price of an offer can never change.",
          ],
        },
        {
          q: "Can I launch my own collection?",
          a: ["Yes, from a Dojang-verified wallet: one artwork for every token (an edition) or your own metadata folder, with up to five phases, each free or paid, public or allowlisted. A phase can be changed until it starts, never after."],
        },
      ],
    },
    {
      h: "Bridge",
      items: [
        {
          q: "Why does withdrawing to Ethereum take 7 days?",
          a: [
            "GIWA is an OP Stack chain with fault proofs: a withdrawal is proven on Ethereum about an hour after it starts and released after a 7-day challenge window. This protects everyone on GIWA.",
          ],
        },
        {
          q: "How can a fast withdrawal take minutes, and is it safe?",
          a: [
            "Jangteo pays you on Ethereum from its own ETH as soon as your GIWA transaction is final enough, then collects your official withdrawal a week later. Large withdrawals wait a few minutes longer, until GIWA's data for them is on Ethereum.",
            "If Jangteo can't pay early (for example when its ETH on Ethereum runs low), the official withdrawal pays you in full after 7 days and the fee is refunded. Your ETH never depends on Jangteo.",
          ],
        },
      ],
    },
    {
      h: "Points",
      items: [
        {
          q: "How do Jangteo Points work?",
          a: [
            "Every stall earns points, counted only from on-chain events, so anyone can recompute them. Only Dojang-verified wallets are ranked. Season 1 runs from 23 September to 31 October 2026 (KST).",
            "Each Korean day you can spin the roulette once (10–500 P) and complete five quests: a swap, a Ppeongtwigi trade, a yut game, an Insadong mint or trade, and a bridge move.",
          ],
        },
        {
          q: "Can the roulette be rigged?",
          a: ["The result comes from the hash of the block after your spin, which nobody knows when you spin, and there is one spin per day, so it can't be re-rolled."],
        },
      ],
    },
    {
      h: "Safety",
      items: [
        {
          q: "Are the contracts verified and audited?",
          a: [
            "Every Jangteo contract is verified on GIWA's explorer (and Ethereum-side contracts on Sourcify and Blockscout), so anyone can read the exact code. They are tested with unit tests, tests against live GIWA pools, and fuzzed invariants that check escrow always matches what users are owed.",
            "They have not had an independent third-party audit yet. We will say so plainly until they have.",
          ],
        },
        {
          q: "Can Jangteo take my funds?",
          a: [
            "No contract gives Jangteo access to your escrowed funds. Admin powers are limited to fees within hard caps, curating listings, and announcing keepers, and changes that could affect open orders are delayed 48 hours.",
          ],
        },
        {
          q: "Where are token images stored?",
          a: ["Uploaded images are squared, re-encoded and pinned to IPFS, or kept on Jangteo's server when IPFS is unavailable. Only the image is stored, never anything else from the file."],
        },
      ],
    },
  ],
};

export const faqKo: FaqDict = {
  h1: "자주 묻는 질문",
  lede: "장터에서 거래하기 전에 많이 묻는 질문을 모았어요. 찾는 답이 없으면 X나 디스코드로 물어봐 주세요.",
  search: "질문 검색",
  none: "일치하는 질문이 없어요. 다른 단어로 찾아보세요.",
  groups: [
    {
      h: "시작하기",
      items: [
        {
          q: "장터는 뭔가요?",
          a: [
            "장터는 업비트의 이더리움 레이어 2인 GIWA 위에 있는 가게들의 모음이에요. 계모임, 청약, 장외, 뻥튀기 런치패드, 인사동 NFT 마켓, GIWA의 모든 거래소를 잇는 애그리게이터가 있는 DEX, 지정가·적립식 주문, 브릿지, 포인트 시즌이 있어요.",
            "모든 것은 테스트넷인 GIWA 세폴리아에서 돌아가요. 테스트 ETH와 테스트 원화는 가치가 없어요.",
          ],
        },
        {
          q: "어떤 지갑이 필요하고, GIWA는 어떻게 추가하나요?",
          a: ["이더리움을 지원하는 브라우저 지갑(메타마스크, 래비, OKX 등)이면 돼요. 연결하면 장터가 지갑에 GIWA 세폴리아(체인 91342)를 추가해 달라고 요청해요."],
        },
        {
          q: "GIWA 테스트 ETH는 어떻게 받나요?",
          a: ["스왑 페이지의 브릿지 탭에서 이더리움 세폴리아 ETH를 보내면 1~3분 안에 도착해요. GIWA 공식 파우셋도 쓸 수 있어요. 세폴리아 ETH는 세폴리아 파우셋에서 받을 수 있어요."],
        },
        {
          q: "도장 인증은 뭐고, 왜 일부 가게에서 필요한가요?",
          a: [
            "도장은 GIWA의 온체인 신원 증명이에요. 인증된 한 사람은 인증된 지갑 하나만 가질 수 있어서, 사람 단위로 나누는 가게(청약 배정, 계모임, 윷놀이, 토큰 출시, 포인트 순위)는 한 사람이 여러 명인 척하지 못하게 도장을 확인해요.",
            "거래, 스왑, 브릿지는 모든 지갑에 열려 있어요.",
          ],
        },
      ],
    },
    {
      h: "수수료",
      items: [
        {
          q: "장터는 수수료를 얼마나 받나요?",
          a: ["모든 수수료는 컨트랙트에 정해져 있고 상한도 컨트랙트에 걸려 있어요. 서명하기 전에 항상 보여 드려요."],
          table: [
            ["장터 스왑", "스왑마다 0.3%: 유동성 공급자 0.25%, 장터 0.05%"],
            ["애그리게이터", "다른 GIWA DEX를 거치는 경로 0.1%, 장터 스왑 안에서는 없음"],
            ["지정가 / 적립식", "체결마다 0.1%"],
            ["뻥튀기", "커브 거래마다 1%(절반은 토큰 출시자에게), 졸업 때 1%"],
            ["인사동 민팅", "민팅 수익의 0.5%, 창작자가 부담해요. 무료 민팅은 없음"],
            ["인사동 거래", "가격의 0.5%(2026년 9월 28일부터, 그 전에는 2%), 그리고 창작자가 정한 로열티(최대 10%)"],
            ["GIWA로 브릿지", "0.5%"],
            ["이더리움으로 출금", "0.5%(7일) 또는 빠른 출금 1% + 0.0005 ETH(몇 분)"],
            ["청약", "모집 금액의 2%"],
            ["장외", "거래가 완료될 때만 대금의 2%"],
            ["상장 예측", "1%"],
            ["계모임", "곗돈마다 1%"],
            ["윷놀이", "판돈의 3%"],
          ],
        },
      ],
    },
    {
      h: "거래",
      items: [
        {
          q: "스왑 가격은 어디서 오나요?",
          a: ["장터 스왑은 Uniswap이 공개한 Uniswap V2 그대로예요. 애그리게이터는 GIWA의 다른 DEX(Uniswap V2/V3 포크, 나루스왑, 카치스왑 등) 풀까지 모두 견적을 내서 가장 많이 받는 경로로 체결하고, 최소 수령량은 온체인에서 지켜져요."],
        },
        {
          q: "지정가와 적립식 주문은 어떻게 동작하나요?",
          a: [
            "주문 금액은 주문 컨트랙트에 보관돼요. 시장가가 지정가에 닿으면(지정가) 또는 정해진 주기마다(적립식) 장터 키퍼가 애그리게이터로 체결하고, 설정한 비율보다 나쁘게는 절대 체결되지 않아요. 받는 토큰은 바로 내 지갑으로 가요.",
            "언제든 취소하면 남은 금액이 바로 돌아와요. 공지된 키퍼만 체결할 수 있고, 새 키퍼는 공지 48시간 뒤에야 활동할 수 있어서 항상 취소할 시간이 있어요.",
          ],
        },
        {
          q: "거래 화면의 호가창은 뭔가요?",
          a: ["장터의 미체결 지정가 주문과 현재가 주변 풀의 유동성을 함께 보여줘요. 호가를 누르면 그 가격으로 지정가 주문을 넣을 수 있어요."],
        },
      ],
    },
    {
      h: "뻥튀기 (런치패드)",
      items: [
        {
          q: "토큰 출시는 어떻게 되나요?",
          a: [
            "인증된 출시자가 본딩 커브로 토큰을 내면 살 때마다 가격이 올라가요. 커브에 4.2 ETH가 모이면 뻥! 졸업해요. 커브가 닫히고 마지막 가격 그대로 장터 스왑에 상장되며, 유동성은 영구히 잠겨요.",
            "커브에서는 누구나 사고팔 수 있고, 다른 앱이나 봇도 뻥튀기 라우터로 거래할 수 있어요.",
          ],
        },
        {
          q: "출시자가 물량을 던질 수 있나요?",
          a: ["출시자의 첫 매수에는 상한이 있고, 공급량은 토큰을 만들 때 고정되며, 졸업 유동성은 풀에 영구히 잠겨요. 그래도 거래되는 모든 것처럼 토큰 가격은 떨어질 수 있어요."],
        },
      ],
    },
    {
      h: "인사동 (NFT)",
      items: [
        {
          q: "탈은 무엇이고 어떻게 받나요?",
          a: [
            "탈은 장터가 만든 컬렉션이에요. 한국 탈 1,000개가 모두 온체인으로 그려져요. 민팅은 화이트리스트 이벤트로 먼저 열리고, 그다음 퍼블릭 판매가 이어져요. 날짜, 가격, 화이트리스트 참여 방법은 장터 X와 디스코드에서 먼저 알려 드려요.",
            "그림과 특성은 공개 전까지 가려져 있고, 공개에는 민팅 동안 아무도 모르는 블록 해시를 써요. 보유자는 장터 포인트를 10% 더 받아요.",
          ],
        },
        {
          q: "판매 등록한 NFT는 안전한가요?",
          a: [
            "NFT는 내 지갑에 그대로 있어요. 판매 등록은 누군가 정확히 그 가격을 낼 때만 마켓이 옮길 수 있게 해 줄 뿐이에요. 다른 곳으로 옮기거나 팔면 예전 등록은 더 이상 살 수 없어요.",
            "제안한 ETH는 내가 수락하거나 제안자가 취소할 때까지 마켓 컨트랙트에 보관되고, 제안 가격은 절대 바뀌지 않아요.",
          ],
        },
        {
          q: "내 컬렉션을 출시할 수 있나요?",
          a: ["네, Dojang 인증 지갑이면 돼요. 모든 토큰에 같은 작품(에디션) 또는 내 메타데이터 폴더로, 최대 다섯 단계까지 무료나 유료, 퍼블릭이나 화이트리스트로 정할 수 있어요. 단계는 시작하기 전까지만 바꿀 수 있어요."],
        },
      ],
    },
    {
      h: "브릿지",
      items: [
        {
          q: "이더리움으로 출금하면 왜 7일이 걸리나요?",
          a: ["GIWA는 폴트 프루프를 쓰는 OP Stack 체인이에요. 출금은 시작 후 약 1시간 뒤 이더리움에서 증명되고, 7일의 이의 제기 기간이 지나야 풀려요. GIWA의 모든 사용자를 지키는 장치예요."],
        },
        {
          q: "빠른 출금은 어떻게 몇 분이면 되고, 안전한가요?",
          a: [
            "GIWA 트랜잭션이 충분히 확정되면 장터가 자기 ETH로 이더리움에서 먼저 보내 드리고, 일주일 뒤 공식 출금을 대신 받아요. 큰 금액은 GIWA 데이터가 이더리움에 기록될 때까지 몇 분 더 기다려요.",
            "장터가 먼저 보내지 못하면(예: 이더리움 쪽 ETH가 부족할 때) 7일 뒤 공식 출금이 전액을 보내고 수수료도 돌려받아요. 내 ETH는 장터에 의존하지 않아요.",
          ],
        },
      ],
    },
    {
      h: "포인트",
      items: [
        {
          q: "장터 포인트는 어떻게 쌓이나요?",
          a: [
            "모든 가게에서 포인트가 쌓이고, 온체인 기록만으로 계산해서 누구나 다시 계산해 볼 수 있어요. 도장 인증 지갑만 순위에 올라요. 시즌 1은 2026년 9월 23일부터 10월 31일까지(한국 시간)예요.",
            "한국 날짜로 하루에 한 번 룰렛(10~500P)을 돌리고, 스왑·뻥튀기 거래·윷놀이·인사동 민팅이나 거래·브릿지 다섯 가지 미션을 할 수 있어요.",
          ],
        },
        {
          q: "룰렛을 조작할 수 있나요?",
          a: ["결과는 돌린 다음 블록의 해시로 정해져요. 돌릴 때는 아무도 그 해시를 모르고, 하루에 한 번뿐이라 다시 돌릴 수도 없어요."],
        },
      ],
    },
    {
      h: "안전",
      items: [
        {
          q: "컨트랙트는 검증되고 감사를 받았나요?",
          a: [
            "장터의 모든 컨트랙트는 GIWA 익스플로러에서 검증돼 있고(이더리움 쪽은 Sourcify와 Blockscout), 누구나 실제 코드를 읽을 수 있어요. 단위 테스트, 실제 GIWA 풀을 대상으로 한 테스트, 그리고 보관된 금액이 사용자에게 줘야 할 금액과 항상 같은지 확인하는 퍼즈 불변식 테스트를 거쳤어요.",
            "아직 독립된 외부 감사는 받지 않았어요. 받기 전까지는 분명히 그렇게 말씀드릴게요.",
          ],
        },
        {
          q: "장터가 내 자금을 가져갈 수 있나요?",
          a: ["어떤 컨트랙트도 장터에게 보관된 자금에 접근할 권한을 주지 않아요. 관리자 권한은 상한이 걸린 수수료, 상장 관리, 키퍼 공지로 한정되고, 미체결 주문에 영향을 줄 수 있는 변경은 48시간 뒤에야 적용돼요."],
        },
        {
          q: "토큰 이미지는 어디에 저장되나요?",
          a: ["올린 이미지는 정사각형으로 잘라 다시 인코딩한 뒤 IPFS에 고정하고, IPFS를 쓸 수 없을 때는 장터 서버에 보관해요. 파일에서 이미지 외의 것은 아무것도 저장하지 않아요."],
        },
      ],
    },
  ],
};
