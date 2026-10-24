/**
 * submit.js — 응답 기록, 채점, 상태 관리 및 선택적 제출 모듈
 * 
 * [교사용 안내 — Google Apps Script 연동 시 참고]
 * 1. 학생들의 퀴즈 응답 결과를 구글 스프레드시트에 자동 수집하려면 아래 SUBMISSION_ENDPOINT에
 *    Google Apps Script 웹 앱 URL('https://script.google.com/macros/s/.../exec')을 입력하세요.
 * 2. SUBMISSION_ENDPOINT가 빈 문자열('')인 경우, 어떠한 외부 네트워크 요청도 발생하지 않으며
 *    학생 화면에 기록 상태 문구도 표시되지 않습니다.
 * 3. [개인정보 처리 지침 준수 안내]:
 *    - 본 시스템은 학생의 이름, 사진, 연락처 등 불필요한 개인정보를 일절 요구하거나 저장하지 않습니다.
 *    - '반'과 '번호'는 이번 수업 활동의 최소한의 식별 정보로만 사용되며, 브라우저 세션 메모리에만 유지되고
 *      localStorage나 쿠키에 영구 저장되지 않습니다.
 *    - 실제 학교 현장에서 Apps Script를 통해 외부 전송할 때는 수집 목적, 보유 기간, 삭제 방침 등
 *      학교의 개인정보 처리 지침을 반드시 확인해 주시기 바랍니다.
 */

// Google Apps Script 웹 앱 URL (미설정 시 빈 문자열 유지)
const SUBMISSION_ENDPOINT = '';

/**
 * QuizEngine: 퀴즈 게임의 상태와 채점을 전담하는 단일 상태 관리 객체
 */
window.QuizEngine = {
  // 세션 식별 정보 (1~99 정수)
  classNumber: null,
  studentNumber: null,

  // 진행 상태
  currentGateIndex: 0,
  score: 0,
  combo: 0,
  maxCombo: 0,
  correctCount: 0,
  totalQuestions: 10,

  // 응답 기록: { questionId, selectedIndex, isCorrect }
  answers: [],

  // 각 관문별 상태 (첫 시도 여부 및 문 개방 여부)
  firstAttemptRecorded: [],
  gatePassed: [],

  // 전송 완료 여부 플래그 (한 판당 1회 전송)
  hasSubmitted: false,

  /**
   * 초기화
   */
  init: function() {
    this.totalQuestions = (window.QUIZ_DATA && window.QUIZ_DATA.questions) 
      ? window.QUIZ_DATA.questions.length 
      : 10;
    this.resetGame();
  },

  /**
   * 게임 상태 및 반·번호 완전 초기화 (새로운 학생 또는 재시작용)
   */
  resetGame: function() {
    this.classNumber = null;
    this.studentNumber = null;
    this.currentGateIndex = 0;
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.correctCount = 0;
    this.answers = [];
    this.firstAttemptRecorded = new Array(this.totalQuestions).fill(false);
    this.gatePassed = new Array(this.totalQuestions).fill(false);
    this.hasSubmitted = false;
  },

  /**
   * 반·번호 유효성 검증
   * - 1~99 정수만 허용
   * - 빈값, 문자, 음수, 0, 소수점, 100 이상 차단
   */
  validateStudentInfo: function(classInput, numberInput) {
    // 공백 제거
    const rawClass = String(classInput || '').trim();
    const rawNumber = String(numberInput || '').trim();

    if (!rawClass) {
      return {
        valid: false,
        field: 'class',
        message: '반을 입력해 주세요! (1~99)'
      };
    }

    if (!/^\d+$/.test(rawClass)) {
      return {
        valid: false,
        field: 'class',
        message: '반은 1부터 99까지의 숫자만 입력할 수 있어요!'
      };
    }

    const classNum = parseInt(rawClass, 10);
    if (classNum < 1 || classNum > 99) {
      return {
        valid: false,
        field: 'class',
        message: '반은 1반부터 99반 사이로 입력해 주세요!'
      };
    }

    if (!rawNumber) {
      return {
        valid: false,
        field: 'number',
        message: '번호를 입력해 주세요! (1~99)'
      };
    }

    if (!/^\d+$/.test(rawNumber)) {
      return {
        valid: false,
        field: 'number',
        message: '번호는 1부터 99까지의 숫자만 입력할 수 있어요!'
      };
    }

    const studentNum = parseInt(rawNumber, 10);
    if (studentNum < 1 || studentNum > 99) {
      return {
        valid: false,
        field: 'number',
        message: '번호는 1번부터 99번 사이로 입력해 주세요!'
      };
    }

    return {
      valid: true,
      field: null,
      message: '',
      classNumber: classNum,
      studentNumber: studentNum
    };
  },

  /**
   * 검증된 학생 정보 세션 저장
   */
  setStudentInfo: function(classNum, studentNum) {
    this.classNumber = classNum;
    this.studentNumber = studentNum;
  },

  /**
   * 학생 식별 표시 문자열 생성 (예: '3반 12번')
   */
  getStudentLabel: function() {
    if (this.classNumber && this.studentNumber) {
      return `${this.classNumber}반 ${this.studentNumber}번`;
    }
    return '';
  },

  /**
   * 관문 퀴즈 답변 채점
   * @param {number} gateIndex - 문항 인덱스 (0~9)
   * @param {number} selectedIndex - 선택한 보기 인덱스 (0~3)
   */
  submitGateAnswer: function(gateIndex, selectedIndex) {
    if (!window.QUIZ_DATA || !window.QUIZ_DATA.questions[gateIndex]) {
      return null;
    }

    const question = window.QUIZ_DATA.questions[gateIndex];
    const isCorrect = (selectedIndex === question.answer);
    const isFirstAttempt = !this.firstAttemptRecorded[gateIndex];

    let earnedPoints = 0;
    let bonusPoints = 0;

    if (isFirstAttempt) {
      this.firstAttemptRecorded[gateIndex] = true;

      if (isCorrect) {
        this.correctCount++;
        this.combo++;
        if (this.combo > this.maxCombo) {
          this.maxCombo = this.combo;
        }

        // 기본 점수 100점
        earnedPoints = 100;

        // 2연속 정답부터 min(combo, 5) * 20 추가 보너스
        if (this.combo >= 2) {
          bonusPoints = Math.min(this.combo, 5) * 20;
          earnedPoints += bonusPoints;
        }

        this.score += earnedPoints;
        this.gatePassed[gateIndex] = true;
      } else {
        // 오답 시 감점 없이 콤보 초기화
        this.combo = 0;
      }

      // 첫 응답을 공식 제출 기록에 보관
      this.answers[gateIndex] = {
        questionId: question.id,
        selectedIndex: selectedIndex,
        isCorrect: isCorrect
      };
    } else {
      // 재도전(오답 후 다시 풀기)
      if (isCorrect) {
        this.gatePassed[gateIndex] = true;
      }
    }

    return {
      isCorrect: isCorrect,
      isFirstAttempt: isFirstAttempt,
      earnedPoints: earnedPoints,
      bonusPoints: bonusPoints,
      currentCombo: this.combo,
      totalScore: this.score,
      explanation: question.explanation,
      correctAnswerIndex: question.answer,
      gatePassed: this.gatePassed[gateIndex]
    };
  },

  /**
   * 누적 정답 수에 따른 레벨 계산
   * 0~2개: Lv.1 탐험가, 3~5개: Lv.2 수호자, 6~8개: Lv.3 마스터, 9개 이상: Lv.4 저작권 챔피언
   */
  getCurrentLevel: function() {
    const c = this.correctCount;
    if (c >= 9) {
      return { level: 4, name: '저작권 챔피언', badge: 'Lv.4' };
    } else if (c >= 6) {
      return { level: 3, name: '마스터', badge: 'Lv.3' };
    } else if (c >= 3) {
      return { level: 2, name: '수호자', badge: 'Lv.2' };
    } else {
      return { level: 1, name: '탐험가', badge: 'Lv.1' };
    }
  },

  /**
   * 정답률(0~100%)에 따른 등급 계산
   * 0~39% 도전자, 40~59% 성장 중, 60~79% 실버, 80~99% 골드, 100% 챔피언
   */
  getGrade: function(accuracy) {
    if (accuracy === 100) return '챔피언';
    if (accuracy >= 80) return '골드';
    if (accuracy >= 60) return '실버';
    if (accuracy >= 40) return '성장 중';
    return '도전자';
  },

  /**
   * 모든 관문을 통과했는지 확인
   */
  isAllGatesCleared: function() {
    return this.gatePassed.length === this.totalQuestions && 
           this.gatePassed.every(function(passed) { return passed === true; });
  },

  /**
   * AGENTS.md 7장 규격 100% 준수: buildSubmissionPayload()
   * 반·번호가 유효하지 않으면 null 반환하여 전송 차단
   */
  buildSubmissionPayload: function() {
    if (!this.classNumber || !this.studentNumber || 
        this.classNumber < 1 || this.classNumber > 99 || 
        this.studentNumber < 1 || this.studentNumber > 99) {
      return null;
    }

    const accuracy = this.totalQuestions > 0 
      ? Math.round((this.correctCount / this.totalQuestions) * 100) 
      : 0;

    const formattedAnswers = [];
    const questions = (window.QUIZ_DATA && window.QUIZ_DATA.questions) ? window.QUIZ_DATA.questions : [];

    for (let i = 0; i < this.totalQuestions; i++) {
      const q = questions[i];
      const recorded = this.answers[i];
      if (recorded) {
        formattedAnswers.push({
          questionId: recorded.questionId || (q ? q.id : `q${i+1}`),
          selectedIndex: typeof recorded.selectedIndex === 'number' ? recorded.selectedIndex : 0,
          isCorrect: Boolean(recorded.isCorrect)
        });
      } else {
        formattedAnswers.push({
          questionId: q ? q.id : `q${i+1}`,
          selectedIndex: -1,
          isCorrect: false
        });
      }
    }

    return {
      quizTitle: (window.QUIZ_DATA && window.QUIZ_DATA.title) ? window.QUIZ_DATA.title : '미로 탈출 저작권 챔피언',
      classNumber: Number(this.classNumber),
      studentNumber: Number(this.studentNumber),
      score: Number(this.score),
      correctCount: Number(this.correctCount),
      totalQuestions: Number(this.totalQuestions),
      accuracy: Number(accuracy),
      maxCombo: Number(this.maxCombo),
      grade: this.getGrade(accuracy),
      answers: formattedAnswers
    };
  },

  /**
   * 선택적 결과 전송
   * - SUBMISSION_ENDPOINT가 비어있으면 전송하지 않음
   * - text/plain;charset=utf-8 헤더 사용 (CORS preflight 방지)
   * - 성공 여부는 실제 JSON 응답의 ok === true로만 판별
   */
  sendSubmission: function(onStatusChange) {
    if (!SUBMISSION_ENDPOINT || typeof SUBMISSION_ENDPOINT !== 'string' || !SUBMISSION_ENDPOINT.trim()) {
      return; // 미설정 시 전송 없음
    }

    if (this.hasSubmitted) {
      return; // 판당 1회만 전송
    }

    const payload = this.buildSubmissionPayload();
    if (!payload) {
      if (typeof onStatusChange === 'function') {
        onStatusChange('error', '기록하지 못했어요. 선생님께 알려 주세요');
      }
      return;
    }

    this.hasSubmitted = true;

    if (typeof onStatusChange === 'function') {
      onStatusChange('sending', '기록 중…');
    }

    fetch(SUBMISSION_ENDPOINT.trim(), {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify(payload)
    })
    .then(function(response) {
      if (!response.ok) {
        throw new Error('Network response was not ok');
      }
      return response.json();
    })
    .then(function(data) {
      if (data && data.ok === true) {
        if (typeof onStatusChange === 'function') {
          onStatusChange('success', '기록 완료');
        }
      } else {
        if (typeof onStatusChange === 'function') {
          onStatusChange('error', '기록하지 못했어요. 선생님께 알려 주세요');
        }
      }
    })
    .catch(function(err) {
      console.warn('Submission failed:', err);
      if (typeof onStatusChange === 'function') {
        onStatusChange('error', '기록하지 못했어요. 선생님께 알려 주세요');
      }
    });
  }
};

// 스크립트 로드 시 엔진 초기화
window.QuizEngine.init();
