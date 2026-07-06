// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Plantilla preventiva para fondos futuros de RC Wallet.
/// @dev No recupera fondos ya enviados a una dirección externa. Antes de usar
/// en producción requiere auditoría, pruebas, política de guardianes y revisión legal.
interface IERC20Minimal {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract RCRescueVault {
    uint256 public constant BPS_DENOMINATOR = 10_000;

    address public owner;
    address public feeRecipient;
    uint256 public recoveryFeeBps = 200; // 2%
    uint256 public recoveryDelay = 24 hours;
    uint256 public guardianThreshold;

    mapping(address => bool) public guardians;

    struct RecoveryRequest {
        address token; // address(0) for native coin
        address recipient;
        uint256 amount;
        uint256 executeAfter;
        uint256 approvals;
        bool executed;
    }

    mapping(bytes32 => RecoveryRequest) public recoveryRequests;
    mapping(bytes32 => mapping(address => bool)) public approvedBy;

    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event FeeRecipientChanged(address indexed feeRecipient);
    event GuardianSet(address indexed guardian, bool active);
    event RecoveryRequested(bytes32 indexed requestId, address token, address recipient, uint256 amount);
    event RecoveryApproved(bytes32 indexed requestId, address indexed guardian);
    event RecoveryExecuted(bytes32 indexed requestId, address token, address recipient, uint256 netAmount, uint256 fee);

    modifier onlyOwner() {
        require(msg.sender == owner, "RC: only owner");
        _;
    }

    modifier onlyGuardian() {
        require(guardians[msg.sender], "RC: only guardian");
        _;
    }

    constructor(address initialOwner, address initialFeeRecipient, address[] memory initialGuardians, uint256 threshold) {
        require(initialOwner != address(0), "RC: owner zero");
        require(initialFeeRecipient != address(0), "RC: fee zero");
        require(threshold > 0, "RC: threshold zero");

        owner = initialOwner;
        feeRecipient = initialFeeRecipient;
        guardianThreshold = threshold;

        for (uint256 i = 0; i < initialGuardians.length; i++) {
            require(initialGuardians[i] != address(0), "RC: guardian zero");
            guardians[initialGuardians[i]] = true;
            emit GuardianSet(initialGuardians[i], true);
        }
    }

    receive() external payable {}

    function setOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "RC: owner zero");
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    function setFeeRecipient(address newFeeRecipient) external onlyOwner {
        require(newFeeRecipient != address(0), "RC: fee zero");
        feeRecipient = newFeeRecipient;
        emit FeeRecipientChanged(newFeeRecipient);
    }

    function setGuardian(address guardian, bool active) external onlyOwner {
        require(guardian != address(0), "RC: guardian zero");
        guardians[guardian] = active;
        emit GuardianSet(guardian, active);
    }

    function setGuardianThreshold(uint256 threshold) external onlyOwner {
        require(threshold > 0, "RC: threshold zero");
        guardianThreshold = threshold;
    }

    function setRecoveryFeeBps(uint256 bps) external onlyOwner {
        require(bps <= 1_000, "RC: max 10%");
        recoveryFeeBps = bps;
    }

    function setRecoveryDelay(uint256 delaySeconds) external onlyOwner {
        require(delaySeconds >= 1 hours, "RC: delay too short");
        recoveryDelay = delaySeconds;
    }

    function ownerWithdrawNative(address payable recipient, uint256 amount) external onlyOwner {
        _transferNativeWithFee(recipient, amount);
    }

    function ownerWithdrawERC20(address token, address recipient, uint256 amount) external onlyOwner {
        _transferERC20WithFee(token, recipient, amount);
    }

    function requestRecovery(address token, address recipient, uint256 amount) external onlyGuardian returns (bytes32 requestId) {
        require(recipient != address(0), "RC: recipient zero");
        require(amount > 0, "RC: amount zero");

        requestId = keccak256(
            abi.encode(
                address(this),
                block.chainid,
                token,
                recipient,
                amount,
                block.timestamp,
                msg.sender
            )
        );

        RecoveryRequest storage request = recoveryRequests[requestId];
        require(request.executeAfter == 0, "RC: exists");

        request.token = token;
        request.recipient = recipient;
        request.amount = amount;
        request.executeAfter = block.timestamp + recoveryDelay;

        _approveRecovery(requestId, msg.sender);
        emit RecoveryRequested(requestId, token, recipient, amount);
    }

    function approveRecovery(bytes32 requestId) external onlyGuardian {
        RecoveryRequest storage request = recoveryRequests[requestId];
        require(request.executeAfter != 0, "RC: missing request");
        require(!request.executed, "RC: executed");
        _approveRecovery(requestId, msg.sender);
    }

    function executeRecovery(bytes32 requestId) external {
        RecoveryRequest storage request = recoveryRequests[requestId];
        require(request.executeAfter != 0, "RC: missing request");
        require(!request.executed, "RC: executed");
        require(block.timestamp >= request.executeAfter, "RC: timelocked");
        require(request.approvals >= guardianThreshold, "RC: not enough approvals");

        request.executed = true;

        if (request.token == address(0)) {
            _transferNativeWithFee(payable(request.recipient), request.amount);
        } else {
            _transferERC20WithFee(request.token, request.recipient, request.amount);
        }
    }

    function _approveRecovery(bytes32 requestId, address guardian) internal {
        if (!approvedBy[requestId][guardian]) {
            approvedBy[requestId][guardian] = true;
            recoveryRequests[requestId].approvals += 1;
            emit RecoveryApproved(requestId, guardian);
        }
    }

    function _transferNativeWithFee(address payable recipient, uint256 amount) internal {
        require(address(this).balance >= amount, "RC: insufficient native");
        uint256 fee = (amount * recoveryFeeBps) / BPS_DENOMINATOR;
        uint256 net = amount - fee;

        (bool okRecipient, ) = recipient.call{value: net}("");
        require(okRecipient, "RC: native recipient failed");

        if (fee > 0) {
            (bool okFee, ) = payable(feeRecipient).call{value: fee}("");
            require(okFee, "RC: native fee failed");
        }

        emit RecoveryExecuted(bytes32(0), address(0), recipient, net, fee);
    }

    function _transferERC20WithFee(address token, address recipient, uint256 amount) internal {
        require(token != address(0), "RC: token zero");
        uint256 fee = (amount * recoveryFeeBps) / BPS_DENOMINATOR;
        uint256 net = amount - fee;

        require(IERC20Minimal(token).transfer(recipient, net), "RC: token recipient failed");
        if (fee > 0) {
            require(IERC20Minimal(token).transfer(feeRecipient, fee), "RC: token fee failed");
        }

        emit RecoveryExecuted(bytes32(0), token, recipient, net, fee);
    }
}
