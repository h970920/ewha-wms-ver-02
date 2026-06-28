# 이화산업 WMS — 설치 · 배포 가이드

PC 웹 기반 파레트 적재 관리 시스템 (작업자 우선 화면 + 관리자 페이지).
무선 QR리더기(키보드 웨지)로 스캔하며, 스캔 시 화면 플래시 + 음성 + 비프로 결과를 알립니다.
Supabase를 연결하면 여러 작업자가 같은 재고를 실시간(수 초 단위 동기화)으로 공유합니다.

----------------------------------------------------------------------
## 0. 로그인 계정 (기본)
- 관리자: `admin` / `admin1234`  → 작업 화면 + 관리자 페이지
- 작업자: `ewha01` / `ewha01`     → 작업 화면만
(Supabase 연결 시 users 테이블의 계정으로 로그인)

----------------------------------------------------------------------
## 1. Supabase 준비 (실제 공유 DB) — 공장 테스트는 이 단계 필요
1) https://supabase.com 에서 프로젝트 생성 (무료 플랜 가능)
2) 좌측 메뉴 SQL Editor → New query 에 아래 두 파일을 순서대로 붙여넣고 RUN
   - `ehwa_wms_schema.sql`  (테이블 + 파레트 1,700개 + 적재/취소/상차/초기화 RPC)
   - `ehwa_wms_users.sql`   (로그인 계정 admin / ewha01)
3) 좌측 Project Settings → API 에서 두 값을 복사
   - Project URL        → SUPABASE_URL
   - anon public key     → SUPABASE_ANON_KEY
4) `src/App.jsx` 상단 두 줄을 채움:
   const SUPABASE_URL = "https://xxxx.supabase.co";
   const SUPABASE_ANON_KEY = "eyJhbGciOi...";
   (두 줄을 비워두면 위 기본 계정으로 동작하는 단독 데모 모드)

----------------------------------------------------------------------
## 2. 빌드
    npm install
    npm run build      # dist/ 생성
    npm run preview    # 로컬 미리보기(http://localhost:4173)

----------------------------------------------------------------------
## 3-A. 가장 빠른 배포 (빌드 파일 드래그, 깃헙 불필요)
1) 위 2번으로 dist/ 를 만든다 (또는 동봉된 ehwa-wms-dist.zip 사용 — 단, 이 zip은 데모 모드 빌드)
2) https://app.netlify.com/drop 에 dist 폴더를 드래그&드롭
3) 발급되는 https://OOO.netlify.app 주소가 접속 링크
   ※ Supabase 값을 넣었다면 1번대로 직접 npm run build 한 dist 를 올려야 실DB로 동작

----------------------------------------------------------------------
## 3-B. GitHub + Vercel (권장: push 하면 자동 배포)
### (1) GitHub에 코드 올리기
    # 이 폴더에서
    git init
    git add .
    git commit -m "이화산업 WMS"
    # GitHub에서 빈 저장소 생성 후 (예: ehwa-wms), 아래 주소를 본인 것으로 교체
    git branch -M main
    git remote add origin https://github.com/<본인계정>/ehwa-wms.git
    git push -u origin main
  - 이미 remote가 있으면: git remote set-url origin https://github.com/<본인계정>/ehwa-wms.git

### (2) Vercel 배포
  1) https://vercel.com 로그인 → Add New → Project → GitHub 저장소(ehwa-wms) Import
  2) Framework: Vite 자동 인식 / Build Command: npm run build / Output: dist
  3) Deploy → https://ehwa-wms.vercel.app 같은 링크 발급
  4) 이후 git push 할 때마다 자동 재배포

  ※ Supabase 값을 코드에 직접 넣는 대신 Vercel 환경변수로 관리하려면, App.jsx 상단을
     const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
     const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
     로 바꾸고, Vercel Project → Settings → Environment Variables 에
     VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY 를 등록한다.

----------------------------------------------------------------------
## 4. 무선 QR리더기 설정
  리더기 설정에서 "스캔 후 Enter(CR) 전송"만 켜면 됩니다(대부분 기본 ON).
  PC에 키보드로 인식되어, 스캔값 입력 후 Enter가 들어오면 자동 처리됩니다.

----------------------------------------------------------------------
## 5. 동작 요약 / 주의
  - 적재/취소/상차/초기화의 검증(혼적·중복·9개 완료)은 모두 DB RPC에서 원자적으로 처리됩니다.
  - 화면은 약 6초마다 서버와 동기화되어 여러 작업자가 같은 현황을 봅니다.
  - 보안: 현재 RLS는 파일럿용(익명 읽기/일부 쓰기 허용)입니다. 외부 공개 운영 시
    반드시 인증 기반으로 조이고, 비밀번호는 해시(예: verify_login RPC) 방식으로 바꾸세요.
